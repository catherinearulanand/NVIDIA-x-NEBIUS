FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV MINDVAULT_PROFILE=hosted \
    PORT=8080 \
    MINDVAULT_DATA_DIR=/tmp/mindvault
USER node
EXPOSE 8080
CMD ["node", "server.js"]
