# Deutsch Brava

Juego web mobile-first para practicar **der**, **die** y **das**, en solitario o en salas privadas de 2–4 jugadores.

## Ejecutar el modo individual

Requiere Node.js 18 o posterior:

```sh
npm run dev
```

Abre `http://localhost:4173`. El modo individual no necesita Supabase y conserva el perfil, el vocabulario adaptativo y las estadísticas en `localStorage`.

## Activar el multijugador con Supabase

El código online está integrado, pero este repositorio no contiene un proyecto ni claves de Supabase. El modo individual sigue funcionando mientras preparas estos valores.

1. Crea un proyecto Supabase y activa **Authentication → Sign In / Providers → Anonymous Sign-Ins**. Las identidades anónimas son propias del navegador/dispositivo: si se borran los datos del navegador, ese jugador no podrá recuperar su identidad anterior.
2. En el **SQL Editor**, ejecuta [`supabase/migrations/202611240001_brava_multiplayer.sql`](supabase/migrations/202611240001_brava_multiplayer.sql).
3. En el mismo SQL Editor, ejecuta [`supabase/seed.sql`](supabase/seed.sql) para cargar las 500 palabras. Si cambia `src/words.js`, regenera el archivo con `npm run seed:supabase` y vuelve a ejecutar el seed.
4. Copia la **Project URL** y la clave pública **Publishable** (o la antigua `anon`) desde Project Settings → API Keys. Pégalas en [`src/supabase-config.js`](src/supabase-config.js). No uses la clave `service_role` ni una secret key en el navegador.
5. Publica el sitio en un host estático y pruébalo desde dos a cuatro dispositivos. La primera apertura online necesita Internet para cargar `supabase-js` desde `esm.sh` y conectarse al proyecto. El esquema añade `brava_rooms` y `brava_players` a la publicación de Realtime.

Para una prueba rápida en la misma Wi-Fi, ejecuta `npm run dev` en el ordenador, busca su IPv4 local y abre `http://IP-DEL-ORDENADOR:4173` en cada móvil. El servidor de desarrollo escucha en la red local; quizá tengas que permitir el puerto 4173 en el firewall de Windows. Para amigos fuera de esa red, usa un despliegue público con HTTPS.

Las operaciones que crean salas, aceptan respuestas, cierran rondas y calculan puntos corren en funciones PostgreSQL con privilegios limitados. RLS permite leer la sala y su roster solo a sus miembros; las respuestas y la clave de cada pregunta no son seleccionables desde el navegador. El código cliente solo contiene la clave pública.

Las salas se sincronizan por Supabase Realtime con consulta de respaldo cada tres segundos. El servidor cierra la ronda al recibir todas las respuestas o al vencer el reloj. La consulta de estado permite reconectar; si el anfitrión deja de responder, otro miembro activo toma el rol. La identidad anónima no se transfiere a otro dispositivo: cada jugador se une desde su propio navegador.

### Prueba manual tras configurar Supabase

- Abre el mismo sitio en dos móviles/navegadores distintos; uno crea la sala y el otro introduce el código.
- Repite con tres y cuatro dispositivos; comprueba que el anfitrión no puede iniciar antes de que se una el segundo jugador.
- Responde simultáneamente, deja expirar una ronda y compara que todos ven la misma palabra, artículo correcto y clasificación.
- Recarga una pestaña durante la sala para comprobar la reconexión. En una sala activa, cierra el navegador del anfitrión y confirma que el rol pasa a otro jugador.
- La suite local también comprueba que una clasificación empatada conserve a todos los ganadores.

**Límite de verificación:** no se han probado partidas entre dispositivos contra un proyecto Supabase real porque faltan URL y clave. La suite local prueba la lógica individual, el banco y las invariantes estáticas del SQL; la experiencia online necesita la configuración y pruebas manuales anteriores antes de considerarse validada para producción.

## Pruebas locales

```sh
npm test
```

## Contenido y ampliación

- `src/words.js`: banco independiente de 500 palabras, traducciones, niveles, categorías y plurales útiles.
- `src/engine.js`: selección adaptativa, puntuación, dominio y resultados del modo individual.
- `src/main.js`: interfaz y persistencia individual.
- `src/online.js`: salas, identidad anónima, Realtime, reconexión y UI multijugador.
- `src/supabase-config.js`: valores públicos del proyecto Supabase.
- `supabase/migrations/`: tablas, RLS y RPC autoritativas.
- `supabase/seed.sql`: carga inicial del vocabulario para partidas online.

Las etiquetas A1/A2 son orientativas y se inspiraron en las listas del [Goethe-Institut para A1](https://www.goethe.de/de/spr/prf/ueb/pa1.html) y [A2](https://www.goethe.de/pro/relaunch/prf/sl/Goethe-Zertifikat_A2_Wortliste.pdf); no son una certificación oficial de nivel.

## Publicar

El sitio es estático: sirve los archivos de la raíz con GitHub Pages, Netlify, Cloudflare Pages o Vercel, sin comando de compilación. Para una URL pública, añade también el dominio desplegado a la configuración de URL permitidas de Supabase Auth. El modo multijugador no estará disponible hasta activar Auth, ejecutar la migración y seed, y configurar las dos claves públicas.
