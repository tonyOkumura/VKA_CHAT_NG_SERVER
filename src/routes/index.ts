import { Express } from 'express';
import authRoutes from './authRoutes';
import groupRoutes from './groupRoutes';
import messagesRoutes from './messagesRoutes';
import dialogRoutes from './dialogRoutes';
import contactsRoutes from './contactsRoutes';
import taskRoutes from './taskRoutes';
import usersRoutes from './usersRoutes';

export function setupRoutes(app: Express): void {
    app.use('/auth', authRoutes);
    app.use('/group', groupRoutes);
    app.use('/dialog', dialogRoutes);
    app.use('/messages', messagesRoutes);
    app.use('/contacts', contactsRoutes);
    app.use('/tasks', taskRoutes);
    app.use('/users', usersRoutes);
}