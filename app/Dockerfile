FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build && mkdir -p server/.data && chown node:node server/.data
ENV API_HOST=0.0.0.0 API_PORT=3001 DATA_DIR=/app/server/.data
USER node
EXPOSE 3001
CMD ["npm", "start"]
