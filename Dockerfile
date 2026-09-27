FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
EXPOSE 5183
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "5183"]
