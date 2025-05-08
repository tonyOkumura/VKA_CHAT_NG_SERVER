import express, { Request, Response } from 'express';
import { json } from 'body-parser';
import morgan from 'morgan';
import http from 'http';
import { Server } from 'socket.io';
import { setupRoutes } from './routes';
import { initializeSocketService } from './services/socket/socketService';
import { setupSocketHandlers } from './services/socketHandlers';
import { setupDirectories } from './config/directories';
import { HOST, PORT, CORS_ORIGIN } from './config/constants';

// Инициализация директорий для загрузок
setupDirectories();

// Создание приложения и сервера
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: CORS_ORIGIN,
    },
});

// Настройка middleware
app.use(json());
app.use(morgan('combined'));
app.use((req: Request, res: Response, next: Function) => {
    console.log('Body:', req.body);
    next();
});

// Настройка статических файлов
app.use('/uploads', express.static('uploads'));

// Настройка маршрутов
setupRoutes(app);

// Инициализация Socket.IO сервиса
initializeSocketService(io);
setupSocketHandlers(io);

// Тестовый маршрут
app.get('/', (req: Request, res: Response) => {
    console.log('Test request received');
    res.send('Server is running');
});

// Запуск сервера
server.listen(PORT, HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);
});