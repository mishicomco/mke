-- Se ejecuta como el rol dueño de la app (no como postgres): la SECURITY
-- DEFINER corre como block_mishi, no superusuario, y las vistas quedan con
-- dueño correcto (gotcha documentado en memoria postgres-table-owner-gotcha).
ALTER FUNCTION jwt_sub() OWNER TO block_mishi;  -- como postgres, ANTES del SET ROLE
SET ROLE block_mishi;

-- Lógica de block-mishi como SQL (escalón 3 de la escalera): la que hoy vive
-- en el Fastify (POST /partidas, rankings, stats) expresada como función
-- transaccional + vistas. Expuesta por PostgREST como /rpc y GET de vistas.

-- guardar_partida: inserta la partida, actualiza el record server-side y borra
-- el juego en curso — TODO en una transacción (mejor que el backend actual).
-- SECURITY DEFINER (dueño block_mishi) porque partida no tiene policy de
-- INSERT para el rol web: la ÚNICA puerta de escritura es esta función.
CREATE OR REPLACE FUNCTION guardar_partida(
  puntos int, lineas int, rondas int, mejor_racha int DEFAULT 1
) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  yo text := jwt_sub();
  record_nuevo boolean := false;
BEGIN
  IF yo IS NULL THEN
    RAISE EXCEPTION 'sin sesión' USING ERRCODE = '28000';
  END IF;
  IF puntos < 0 OR lineas < 0 OR rondas < 0 OR mejor_racha < 1 THEN
    RAISE EXCEPTION 'valores inválidos' USING ERRCODE = '22023';
  END IF;
  INSERT INTO partida (usuario_id, puntos, lineas, rondas, mejor_racha)
    VALUES (yo, puntos, lineas, rondas, mejor_racha);
  UPDATE usuario SET record = puntos
    WHERE id = yo AND puntos > record
    RETURNING true INTO record_nuevo;
  DELETE FROM juego_actual WHERE usuario_id = yo;
  RETURN json_build_object('recordNuevo', COALESCE(record_nuevo, false));
END $$;
REVOKE ALL ON FUNCTION guardar_partida(int,int,int,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guardar_partida(int,int,int,int) TO block_mishi_web;

-- ranking de siempre: top-20 por record
CREATE OR REPLACE VIEW ranking AS
  SELECT u.nombre, u.record AS puntos
  FROM usuario u WHERE u.record > 0
  ORDER BY u.record DESC, u.creado ASC LIMIT 20;

-- ranking semanal: semana ISO (lunes) America/Bogota, máx puntos por usuario
CREATE OR REPLACE VIEW ranking_semanal AS
  SELECT u.nombre, MAX(p.puntos) AS puntos
  FROM partida p JOIN usuario u ON u.id = p.usuario_id
  WHERE date_trunc('week', p.creado AT TIME ZONE 'America/Bogota')
      = date_trunc('week', now() AT TIME ZONE 'America/Bogota')
  GROUP BY u.id, u.nombre
  ORDER BY puntos DESC LIMIT 20;

-- mis stats (la vista filtra por el sub del JWT — cada quien ve las suyas)
CREATE OR REPLACE VIEW mis_stats AS
  SELECT COUNT(*)::int AS partidas,
         COALESCE(MAX(p.puntos),0)::int AS mejor_puntaje,
         COALESCE(ROUND(AVG(p.puntos)),0)::int AS promedio,
         COALESCE(MAX(p.mejor_racha),1)::int AS mejor_racha,
         COALESCE(SUM(p.lineas),0)::int AS lineas
  FROM partida p WHERE p.usuario_id = jwt_sub();

-- las vistas corren con los permisos del dueño (postgres 15+: security_invoker
-- off por default) — se dejan invoker=false a propósito para que ranking lea
-- todas las partidas, y la puerta de sesión es la ForwardAuth + el 401 del JWT.
GRANT SELECT ON ranking, ranking_semanal, mis_stats TO block_mishi_web;
