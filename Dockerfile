FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.mjs market.mjs jev.mjs index.html ./

ENV HOST=0.0.0.0
ENV PORT=4362
EXPOSE 4362

CMD ["node", "server.mjs"]
