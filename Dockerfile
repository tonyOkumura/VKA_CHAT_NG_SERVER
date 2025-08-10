FROM node:18

WORKDIR /app

COPY package*.json ./

RUN npm install -g typescript

RUN npm install

COPY . .

RUN npm run build

EXPOSE 6060

CMD ["npm", "start"]