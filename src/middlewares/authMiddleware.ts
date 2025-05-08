import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
// (Опционально) import { Pool } from 'pg'; // Для проверки is_online

// Интерфейс для декодированного токена
interface TokenPayload extends JwtPayload {
  id: string;
  username: string;
}

export const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  // Извлечение токена
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    console.warn('No token provided');
    res.status(403).json({ error: 'No token provided' });
    return;
  }

  try {
    // Верификация токена
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'worisecretkey') as TokenPayload;

    // Добавление req.user
    req.user = { id: decoded.id, username: decoded.username };

    // Логирование успешной верификации (опционально)
    console.info(`Token verified for user ${decoded.username}`);

    next();
  } catch (err) {
    // Обработка ошибок
    const error = err as Error;
    console.error(`Token verification failed - ${error.message}`);
    if (error.name === 'TokenExpiredError') {
      res.status(401).json({ error: 'Token expired' });
    } else {
      res.status(401).json({ error: 'Invalid token' });
    }
  }
};