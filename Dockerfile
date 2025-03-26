FROM node:18

WORKDIR /app

COPY package*.json ./

RUN npm install -g typescript

RUN npm install

COPY . .

RUN npm run build

EXPOSE 6000

CMD ["npm", "start"]