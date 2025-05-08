import { Express } from 'express';
import authRoutes from './authRoutes';
import conversationsRoutes from './conversationsRoutes';
import messagesRoutes from './messagesRoutes';
import contactsRoutes from './contactsRoutes';
import taskRoutes from './taskRoutes';
import usersRoutes from './usersRoutes';

export function setupRoutes(app: Express): void {
    app.use('/auth', authRoutes);
    app.use('/conversations', conversationsRoutes);
    app.use('/messages', messagesRoutes);
    app.use('/contacts', contactsRoutes);
    app.use('/tasks', taskRoutes);
    app.use('/users', usersRoutes);
}