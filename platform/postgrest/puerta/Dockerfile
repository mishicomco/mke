FROM node:22-alpine
WORKDIR /app
RUN npm install jose@5 --no-audit --no-fund
COPY server.mjs .
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
