-- Partidas privadas de 2–4 personas. Las respuestas y soluciones nunca son
-- consultables directamente desde el navegador; solo las exponen estas RPC.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.brava_words (
  id text primary key,
  noun text not null,
  article text not null check (article in ('der','die','das')),
  translation text not null,
  category text not null,
  level text not null check (level in ('A1','A2')),
  plural text not null default ''
);

create table if not exists public.brava_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  host_user_id uuid not null references auth.users(id),
  phase text not null default 'waiting' check (phase in ('waiting','question','reveal','finished')),
  question_count int not null check (question_count in (10,20,30,50)),
  turn_seconds int not null check (turn_seconds in (10,15,20,30)),
  question_no int not null default 0,
  current_word_id text references public.brava_words(id),
  question_started_at timestamptz,
  deadline_at timestamptz,
  reveal_until timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.brava_players (
  room_id uuid not null references public.brava_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  display_name text not null check (char_length(display_name) between 1 and 18),
  score int not null default 0 check (score >= 0),
  streak int not null default 0,
  max_streak int not null default 0,
  correct_count int not null default 0,
  wrong_count int not null default 0,
  wrong_words text[] not null default '{}',
  is_connected boolean not null default true,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_answer_article text,
  last_answer_correct boolean,
  last_answer_points int not null default 0,
  response_ms int,
  primary key (room_id, user_id)
);

create table if not exists public.brava_room_questions (
  room_id uuid not null references public.brava_rooms(id) on delete cascade,
  question_no int not null,
  word_id text not null references public.brava_words(id),
  correct_article text not null check (correct_article in ('der','die','das')),
  primary key (room_id, question_no),
  unique (room_id, word_id)
);

create table if not exists public.brava_answers (
  room_id uuid not null,
  question_no int not null,
  user_id uuid not null,
  answer_article text check (answer_article in ('der','die','das')),
  is_correct boolean not null default false,
  points int not null default 0 check (points >= 0),
  response_ms int,
  submitted_at timestamptz not null default now(),
  primary key (room_id, question_no, user_id),
  foreign key (room_id, question_no) references public.brava_room_questions(room_id, question_no) on delete cascade,
  foreign key (room_id, user_id) references public.brava_players(room_id, user_id) on delete cascade
);

alter table public.brava_words enable row level security;
alter table public.brava_rooms enable row level security;
alter table public.brava_players enable row level security;
alter table public.brava_room_questions enable row level security;
alter table public.brava_answers enable row level security;

revoke all on public.brava_words, public.brava_rooms, public.brava_players,
  public.brava_room_questions, public.brava_answers from anon, authenticated;
grant select on public.brava_rooms, public.brava_players to authenticated;

create or replace function public.brava_is_member(p_room_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp set row_security = off as $$
  select exists(select 1 from public.brava_players where room_id=p_room_id and user_id=auth.uid())
$$;

drop policy if exists "room members read room signal" on public.brava_rooms;
create policy "room members read room signal" on public.brava_rooms
  for select to authenticated using (public.brava_is_member(id));
drop policy if exists "room members read roster" on public.brava_players;
create policy "room members read roster" on public.brava_players
  for select to authenticated using (public.brava_is_member(brava_players.room_id));

create or replace function public.brava_resolve_locked(p_room_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.brava_rooms%rowtype;
  active_count int;
  answer_count int;
begin
  select * into r from public.brava_rooms where id = p_room_id for update;
  if not found or r.phase <> 'question' then return; end if;

  select count(*) into active_count from public.brava_players
    where room_id = r.id and is_connected and last_seen_at > now() - interval '25 seconds';
  select count(*) into answer_count from public.brava_answers
    where room_id = r.id and question_no = r.question_no;
  if now() < r.deadline_at and answer_count < active_count then return; end if;

  -- Una ronda se cierra al responder todos los conectados o al vencer el reloj.
  insert into public.brava_answers (room_id, question_no, user_id, answer_article, is_correct, points)
  select r.id, r.question_no, p.user_id, null, false, 0
  from public.brava_players p
  where p.room_id = r.id and p.is_connected and p.last_seen_at > now() - interval '25 seconds'
    and not exists (select 1 from public.brava_answers a
      where a.room_id = r.id and a.question_no = r.question_no and a.user_id = p.user_id)
  on conflict do nothing;

  update public.brava_players p set
    score = p.score + a.points,
    correct_count = p.correct_count + case when a.is_correct then 1 else 0 end,
    wrong_count = p.wrong_count + case when a.is_correct then 0 else 1 end,
    streak = case when a.is_correct then p.streak + 1 else 0 end,
    max_streak = greatest(p.max_streak, case when a.is_correct then p.streak + 1 else 0 end),
    wrong_words = case when a.is_correct then p.wrong_words else p.wrong_words || w.noun end,
    last_answer_article = a.answer_article,
    last_answer_correct = a.is_correct,
    last_answer_points = a.points,
    response_ms = a.response_ms
  from public.brava_answers a
  join public.brava_room_questions q on q.room_id = a.room_id and q.question_no = a.question_no
  join public.brava_words w on w.id = q.word_id
  where p.room_id = a.room_id and p.user_id = a.user_id
    and a.room_id = r.id and a.question_no = r.question_no;

  update public.brava_rooms set phase = 'reveal', reveal_until = now() + interval '4 seconds'
    where id = r.id and phase = 'question';
end;
$$;

create or replace function public.brava_create_room(p_display_name text, p_question_count int, p_turn_seconds int default 15)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_code text;
  v_room public.brava_rooms%rowtype;
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
begin
  if v_user is null then raise exception 'Sign in is required'; end if;
  if p_question_count not in (10,20,30,50) then raise exception 'Invalid question count'; end if;
  if p_turn_seconds not in (10,15,20,30) then raise exception 'Invalid round timer'; end if;
  if char_length(trim(p_display_name)) not between 1 and 18 then raise exception 'Name must have 1–18 characters'; end if;
  loop
    select string_agg(substr(alphabet, 1 + (get_byte(extensions.gen_random_bytes(1),0) % char_length(alphabet)), 1), '')
      into v_code from generate_series(1,6);
    exit when not exists (select 1 from public.brava_rooms where code = v_code);
  end loop;
  insert into public.brava_rooms(code, host_user_id, question_count, turn_seconds)
    values (v_code, v_user, p_question_count, p_turn_seconds) returning * into v_room;
  insert into public.brava_players(room_id,user_id,display_name) values (v_room.id,v_user,trim(p_display_name));
  return jsonb_build_object('room_id',v_room.id,'code',v_code);
end;
$$;

create or replace function public.brava_join_room(p_code text, p_display_name text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
  r public.brava_rooms%rowtype;
  existing public.brava_players%rowtype;
  player_count int;
begin
  if v_user is null then raise exception 'Sign in is required'; end if;
  if char_length(trim(p_display_name)) not between 1 and 18 then raise exception 'Name must have 1–18 characters'; end if;
  select * into r from public.brava_rooms where code = upper(trim(p_code)) for update;
  if not found then raise exception 'Room not found'; end if;
  select * into existing from public.brava_players where room_id = r.id and user_id = v_user;
  if found then
    update public.brava_players set display_name = trim(p_display_name), is_connected = true, last_seen_at = now()
      where room_id = r.id and user_id = v_user;
    return jsonb_build_object('room_id',r.id,'code',r.code);
  end if;
  if r.phase <> 'waiting' then raise exception 'This game has already started'; end if;
  delete from public.brava_players where room_id=r.id
    and (not is_connected or last_seen_at <= now() - interval '25 seconds');
  select count(*) into player_count from public.brava_players
    where room_id = r.id and is_connected and last_seen_at > now() - interval '25 seconds';
  if player_count >= 4 then raise exception 'This room is full'; end if;
  insert into public.brava_players(room_id,user_id,display_name) values(r.id,v_user,trim(p_display_name));
  return jsonb_build_object('room_id',r.id,'code',r.code);
end;
$$;

create or replace function public.brava_start_room(p_code text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.brava_rooms%rowtype;
  player_count int;
  v_word_id text;
begin
  select * into r from public.brava_rooms where code = upper(trim(p_code)) for update;
  if not found then raise exception 'Room not found'; end if;
  if r.host_user_id <> auth.uid() then raise exception 'Only the host can start the game'; end if;
  if r.phase <> 'waiting' then raise exception 'The game has already started'; end if;
  select count(*) into player_count from public.brava_players
    where room_id = r.id and is_connected and last_seen_at > now() - interval '25 seconds';
  if player_count < 2 then raise exception 'At least two players are needed'; end if;
  insert into public.brava_room_questions(room_id,question_no,word_id,correct_article)
  select r.id, row_number() over (order by random()), w.id, w.article
  from (select id, article from public.brava_words order by random() limit r.question_count) w;
  select word_id into v_word_id from public.brava_room_questions where room_id = r.id and question_no = 1;
  update public.brava_rooms set phase='question', question_no=1, current_word_id=v_word_id,
    question_started_at=now(), deadline_at=now() + make_interval(secs => r.turn_seconds)
    where id = r.id;
  return jsonb_build_object('advanced',true);
end;
$$;

create or replace function public.brava_submit_answer(p_code text, p_article text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.brava_rooms%rowtype;
  v_word public.brava_words%rowtype;
  v_player public.brava_players%rowtype;
  v_elapsed int;
  v_correct boolean;
  v_points int := 0;
begin
  if p_article is null or p_article not in ('der','die','das') then raise exception 'Invalid article'; end if;
  select * into r from public.brava_rooms where code = upper(trim(p_code)) for update;
  if not found then raise exception 'Room not found'; end if;
  if r.phase <> 'question' then raise exception 'This question is closed'; end if;
  select * into v_player from public.brava_players where room_id=r.id and user_id=auth.uid() and is_connected for update;
  if not found then raise exception 'You are not an active player in this room'; end if;
  if now() >= r.deadline_at then
    perform public.brava_resolve_locked(r.id);
    return jsonb_build_object('accepted',false,'expired',true);
  end if;
  if exists(select 1 from public.brava_answers where room_id=r.id and question_no=r.question_no and user_id=auth.uid()) then
    raise exception 'You already answered this question';
  end if;
  select * into v_word from public.brava_words where id=r.current_word_id;
  v_elapsed := greatest(0, floor(extract(epoch from (now() - r.question_started_at)) * 1000)::int);
  v_correct := p_article = v_word.article;
  if v_correct then
    v_points := 100 + case when v_elapsed < 1800 then 15 when v_elapsed < 3500 then 8 else 0 end
      + least(40,greatest(0,v_player.streak) * 5);
  end if;
  insert into public.brava_answers(room_id,question_no,user_id,answer_article,is_correct,points,response_ms)
    values(r.id,r.question_no,auth.uid(),p_article,v_correct,v_points,v_elapsed);
  perform public.brava_resolve_locked(r.id);
  return jsonb_build_object('accepted',true);
end;
$$;

create or replace function public.brava_advance_room(p_code text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.brava_rooms%rowtype;
  next_word text;
begin
  select * into r from public.brava_rooms where code = upper(trim(p_code)) for update;
  if not found then raise exception 'Room not found'; end if;
  if not exists(select 1 from public.brava_players where room_id=r.id and user_id=auth.uid()) then
    raise exception 'You are not a member of this room';
  end if;
  if r.phase = 'question' and now() >= r.deadline_at then
    perform public.brava_resolve_locked(r.id);
    select * into r from public.brava_rooms where id=r.id;
  elsif r.phase = 'reveal' and now() >= r.reveal_until then
    if r.question_no >= r.question_count then
      update public.brava_rooms set phase='finished',completed_at=now() where id=r.id;
    else
      select word_id into next_word from public.brava_room_questions
        where room_id=r.id and question_no=r.question_no+1;
      update public.brava_players set last_answer_article=null,last_answer_correct=null,last_answer_points=0,response_ms=null
        where room_id=r.id;
      update public.brava_rooms set phase='question',question_no=r.question_no+1,current_word_id=next_word,
        question_started_at=now(),deadline_at=now()+make_interval(secs => r.turn_seconds),reveal_until=null
        where id=r.id;
    end if;
  end if;
  return jsonb_build_object('advanced',true);
end;
$$;

create or replace function public.brava_leave_room(p_code text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.brava_rooms%rowtype;
  departing uuid := auth.uid();
  next_host uuid;
begin
  select * into r from public.brava_rooms where code=upper(trim(p_code)) for update;
  if not found or not exists(select 1 from public.brava_players where room_id=r.id and user_id=departing) then
    raise exception 'You are not a member of this room';
  end if;
  update public.brava_players set is_connected=false,last_seen_at=now() where room_id=r.id and user_id=departing;
  if r.host_user_id=departing then
    select user_id into next_host from public.brava_players where room_id=r.id and user_id<>departing and is_connected
      and last_seen_at > now() - interval '25 seconds'
      order by joined_at limit 1;
    if next_host is not null then update public.brava_rooms set host_user_id=next_host where id=r.id; end if;
  end if;
  if r.phase='question' then perform public.brava_resolve_locked(r.id); end if;
  return jsonb_build_object('left',true);
end;
$$;

create or replace function public.brava_room_state(p_code text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.brava_rooms%rowtype;
  w public.brava_words%rowtype;
  v_user uuid := auth.uid();
  result jsonb;
begin
  select * into r from public.brava_rooms where code=upper(trim(p_code)) for update;
  if not found or not exists(select 1 from public.brava_players where room_id=r.id and user_id=v_user) then
    raise exception 'Room not found or access denied';
  end if;
  update public.brava_players set last_seen_at=now(),is_connected=true
    where room_id=r.id and user_id=v_user
      and (not is_connected or last_seen_at < now() - interval '8 seconds');
  if r.host_user_id<>v_user and not exists(select 1 from public.brava_players where room_id=r.id and user_id=r.host_user_id and is_connected and last_seen_at>now()-interval '25 seconds') then
    update public.brava_rooms set host_user_id=v_user where id=r.id;
    select * into r from public.brava_rooms where id=r.id;
  end if;
  perform public.brava_advance_room(r.code);
  select * into r from public.brava_rooms where id=r.id;
  if r.current_word_id is not null then select * into w from public.brava_words where id=r.current_word_id; end if;
  select jsonb_build_object(
    'id',r.id,'code',r.code,'host_user_id',r.host_user_id,'phase',r.phase,
    'question_count',r.question_count,'turn_seconds',r.turn_seconds,'question_no',r.question_no,
    'current_word',w.noun,'translation',w.translation,'category',w.category,
    'correct_article',case when r.phase in ('reveal','finished') then w.article else null end,
    'deadline_at',r.deadline_at,'reveal_until',r.reveal_until,
    'answered_count',(select count(*) from public.brava_answers a join public.brava_players ap
      on ap.room_id=a.room_id and ap.user_id=a.user_id
      where a.room_id=r.id and a.question_no=r.question_no and ap.is_connected and ap.last_seen_at>now()-interval '25 seconds'),
    'my_answered',exists(select 1 from public.brava_answers a where a.room_id=r.id and a.question_no=r.question_no and a.user_id=v_user),
    'players',coalesce((select jsonb_agg(jsonb_build_object(
      'user_id',p.user_id,'display_name',p.display_name,'score',p.score,'streak',p.streak,
      'max_streak',p.max_streak,'correct_count',p.correct_count,'wrong_count',p.wrong_count,
      'wrong_words',p.wrong_words,'is_connected',p.is_connected and p.last_seen_at>now()-interval '25 seconds',
      'last_answer_article',case when r.phase in ('reveal','finished') then p.last_answer_article else null end,
      'last_answer_correct',case when r.phase in ('reveal','finished') then p.last_answer_correct else null end,
      'last_answer_points',case when r.phase in ('reveal','finished') then p.last_answer_points else null end,
      'response_ms',case when r.phase in ('reveal','finished') then p.response_ms else null end,
      'is_me',p.user_id=v_user,'is_host',p.user_id=r.host_user_id
    ) order by p.joined_at) from public.brava_players p where p.room_id=r.id),'[]'::jsonb)
  ) into result;
  return result;
end;
$$;

create or replace function public.brava_ping(p_code text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room_id uuid;
begin
  select id into v_room_id from public.brava_rooms where code=upper(trim(p_code)) for update;
  if not found then raise exception 'Room not found'; end if;
  update public.brava_players set last_seen_at=now(),is_connected=true
    where room_id=v_room_id and user_id=auth.uid();
  if not found then raise exception 'You are not a member of this room'; end if;
end;
$$;

revoke all on function public.brava_resolve_locked(uuid) from public, anon, authenticated;
revoke all on function public.brava_is_member(uuid) from public, anon;
revoke all on function public.brava_create_room(text,int,int), public.brava_join_room(text,text),
  public.brava_start_room(text), public.brava_submit_answer(text,text), public.brava_advance_room(text),
  public.brava_leave_room(text), public.brava_room_state(text), public.brava_ping(text)
  from public, anon;
grant execute on function public.brava_create_room(text,int,int), public.brava_join_room(text,text),
  public.brava_start_room(text), public.brava_submit_answer(text,text), public.brava_advance_room(text),
  public.brava_leave_room(text), public.brava_room_state(text), public.brava_ping(text)
  to authenticated;
grant execute on function public.brava_is_member(uuid) to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.brava_rooms;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.brava_players;
exception when duplicate_object then null;
end $$;
