// Sustituye estos dos valores por los del proyecto Supabase que vayas a desplegar.
// La publishable/anon key es pública por diseño; nunca pegues aquí una service_role key.
export const SUPABASE_URL = 'https://lurkxmzszwliywibjkvb.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_jVYmsSCodZit10cne2WS4A_ZmQAGVbh';
export const ONLINE_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
