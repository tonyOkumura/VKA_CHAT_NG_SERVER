import express from 'express';
import { uploadFile, downloadFile, getFileInfo, upload } from '../controllers/filesController';
import { verifyToken } from '../middlewares/authMiddleware';

const router = express.Router();

// Загрузка файла
router.post('/upload', verifyToken, upload.single('file'), uploadFile);

// Скачивание файла (теперь POST и fileId в теле запроса)
router.post('/download', verifyToken, downloadFile);

// Получение информации о файле (теперь POST и fileId в теле запроса)
router.post('/info', verifyToken, getFileInfo);

export default router; 