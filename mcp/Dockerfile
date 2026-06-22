FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js ./
# Railway injects PORT; the server reads process.env.PORT.
CMD ["node", "server.js"]
