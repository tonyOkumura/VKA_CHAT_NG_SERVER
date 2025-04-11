import express from 'express';
import { uploadFile, downloadFile, getFileInfo, upload } from '../controllers/filesController';
import { verifyToken } from '../middlewares/authMiddleware';

const router = express.Router();

// Загрузка файла
router.post('/upload', verifyToken, upload.single('file'), uploadFile);

// Скачивание файла
router.get('/download/:fileId', verifyToken, downloadFile);

// Получение информации о файле
router.get('/info/:fileId', verifyToken, getFileInfo);

export default router; 