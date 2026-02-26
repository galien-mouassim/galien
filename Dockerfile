FROM node:20-alpine

WORKDIR /app

# Install backend dependencies first (better layer cache)
COPY galien-backend/package*.json ./galien-backend/
RUN npm --prefix galien-backend ci --omit=dev

# Copy app sources
COPY galien-backend ./galien-backend
COPY galien-frontend ./galien-frontend

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["npm", "--prefix", "galien-backend", "start"]
