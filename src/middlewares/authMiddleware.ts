import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export const verifyToken = (req: Request, res: Response, next: NextFunction): void => {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
        console.warn('No token provided'); // Log warning
        res.status(403).json({ error: 'No token provided' });
        return;
    }

    try {
        const decoded = jwt.verify(token,  'worisecretkey');
        // const decoded = jwt.verify(token, process.env.JWT_TOKEN || 'worisecretkey');
        
        
        next();
    } catch (e) {
        console.error(`Invalid token - ${(e as Error).message}`); // Log error
        res.status(401).json({ error: 'Invalid token' });
    }
};
