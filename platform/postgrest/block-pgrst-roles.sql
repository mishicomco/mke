-- Capa PostgREST para block_mishi (stage) — milestone 1 del estándar nuevo.
-- El rol dueño `block_mishi` (Fastify actual) BYPASSA RLS (no FORCE): la app
-- vieja sigue intacta mientras convive con PostgREST.

-- rol web (NOLOGIN): el que asume PostgREST para cada request
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'block_mishi_web') THEN
    CREATE ROLE block_mishi_web NOLOGIN;
  END IF;
END $$;

-- rol authenticator (LOGIN): la conexión de PostgREST; solo puede SET ROLE web.
-- (el CREATE va aparte porque :'var' no interpola dentro de DO)
SELECT 'CREATE ROLE block_mishi_pgrst NOINHERIT'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'block_mishi_pgrst') \gexec
ALTER ROLE block_mishi_pgrst WITH LOGIN NOINHERIT PASSWORD :'pgrst_pw';
GRANT block_mishi_web TO block_mishi_pgrst;
GRANT CONNECT ON DATABASE block_mishi TO block_mishi_pgrst;

GRANT USAGE ON SCHEMA public TO block_mishi_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON usuario, juego_actual TO block_mishi_web;
GRANT SELECT, INSERT ON partida TO block_mishi_web;

-- RLS: el sub del JWT (claims que PostgREST publica en request.jwt.claims)
ALTER TABLE usuario ENABLE ROW LEVEL SECURITY;
ALTER TABLE partida ENABLE ROW LEVEL SECURITY;
ALTER TABLE juego_actual ENABLE ROW LEVEL SECURITY;

-- helper estable para las políticas
CREATE OR REPLACE FUNCTION jwt_sub() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT current_setting('request.jwt.claims', true)::json->>'sub' $$;

-- usuario: todos con sesión leen (nombres del ranking); solo el dueño se toca
DROP POLICY IF EXISTS usuario_leer ON usuario;
CREATE POLICY usuario_leer ON usuario FOR SELECT USING (jwt_sub() IS NOT NULL);
DROP POLICY IF EXISTS usuario_propio_ins ON usuario;
CREATE POLICY usuario_propio_ins ON usuario FOR INSERT WITH CHECK (id = jwt_sub());
DROP POLICY IF EXISTS usuario_propio_upd ON usuario;
CREATE POLICY usuario_propio_upd ON usuario FOR UPDATE USING (id = jwt_sub());

-- partida: lecturas con sesión (rankings/stats); insert SOLO vía rpc (función
-- SECURITY DEFINER guardar_partida) — sin policy de INSERT para el rol web
DROP POLICY IF EXISTS partida_leer ON partida;
CREATE POLICY partida_leer ON partida FOR SELECT USING (jwt_sub() IS NOT NULL);

-- juego_actual: SOLO el dueño (es su partida en curso, dato privado)
DROP POLICY IF EXISTS juego_propio ON juego_actual;
CREATE POLICY juego_propio ON juego_actual FOR ALL
  USING (usuario_id = jwt_sub()) WITH CHECK (usuario_id = jwt_sub());
