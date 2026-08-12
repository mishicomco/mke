# postgrest-flota: el binario oficial de PostgREST + Node para el supervisor.
FROM postgrest/postgrest:v12.2.12 AS pgrst

FROM node:22-alpine
COPY --from=pgrst /bin/postgrest /usr/local/bin/postgrest
WORKDIR /app
COPY supervisor.mjs .
USER node
EXPOSE 3000
CMD ["node", "supervisor.mjs"]
