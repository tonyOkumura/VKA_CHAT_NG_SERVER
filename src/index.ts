import express, { Request, Response } from 'express';
import { json } from 'body-parser';
import authRoutes from './routes/authRoutes';
import conversationsRoutes from './routes/conversationsRoutes';
import messagesRoutes from './routes/messagesRoutes';
import http from 'http';
import { Server } from 'socket.io';
import { saveMessage } from './controllers/messagesController'; // Import saveMessage
import contactsRoutes from './routes/contactsRoutes';
import pool from './models/db';
import { fetchAllParticipantsByConversationId, fetchAllParticipantsByConversationIdForMessages } from './controllers/conversationController';
import { updateUserOnlineStatus } from './controllers/userController';

const app = express();
const server = http.createServer(app);
app.use(json());
const io = new Server(server, {
    cors: {
        origin: '*',
    },
});

app.use('/auth', authRoutes);
app.use('/conversations', conversationsRoutes);
app.use('/messages', messagesRoutes);
app.use('/contacts', contactsRoutes);

app.get('/', (req: Request, res: Response) => {
    console.log("test");
    res.send("yes it works");
});

// Хранилище для сопоставления socket.id и userId
const userSockets = new Map<string, string>();

io.on('connection', async (socket) => {
    console.log('Пользователь подключился: ', socket.id);

    // Обработка аутентификации пользователя
    socket.on('authenticate', async (userId: string) => {
        try {
            // Сохраняем соответствие socket.id и userId
            userSockets.set(socket.id, userId);
            
            // Обновляем статус пользователя на онлайн
            await updateUserOnlineStatus(userId, true);
            
            // Уведомляем всех о том, что пользователь онлайн
            io.emit('userStatusChanged', { userId, isOnline: true });
            
            console.log(`Пользователь ${userId} аутентифицирован и отмечен как онлайн`);
        } catch (error) {
            console.error('Ошибка при аутентификации пользователя:', error);
        }
    });

    socket.on('joinConversation', async (conversationId) => {
        socket.join(conversationId);
        console.log('Пользователь присоединился к разговору: ' + conversationId);

        try {
            const userId = userSockets.get(socket.id);
            if (userId) {
                // Отмечаем все сообщения в чате как прочитанные
                await pool.query(
                    `
                    INSERT INTO message_reads (message_id, user_id, read_at)
                    SELECT m.id, $1, NOW()
                    FROM messages m
                    WHERE m.conversation_id = $2
                    AND NOT EXISTS (
                        SELECT 1 
                        FROM message_reads mr 
                        WHERE mr.message_id = m.id 
                        AND mr.user_id = $1
                    )
                    `,
                    [userId, conversationId]
                );

                // Получаем всех участников чата
                const participants = await fetchAllParticipantsByConversationIdForMessages(conversationId);
                if (participants) {
                    // Уведомляем всех участников о прочтении сообщений
                    io.to(conversationId).emit('messagesRead', {
                        conversation_id: conversationId,
                        user_id: userId,
                        read_at: new Date()
                    });
                }
            }
        } catch (error) {
            console.error('Ошибка при обработке прочтения сообщений:', error);
        }
    });

    // Добавляем новый обработчик для прочтения сообщений
    socket.on('markMessagesAsRead', async ({ conversation_id, message_ids }) => {
        try {
            const userId = userSockets.get(socket.id);
            if (userId) {
                // Отмечаем указанные сообщения как прочитанные
                await pool.query(
                    `
                    INSERT INTO message_reads (message_id, user_id, read_at)
                    SELECT unnest($1::uuid[]), $2, NOW()
                    ON CONFLICT (message_id, user_id) DO NOTHING
                    `,
                    [message_ids, userId]
                );

                // Уведомляем всех участников о прочтении сообщений
                io.to(conversation_id).emit('messagesRead', {
                    conversation_id,
                    user_id: userId,
                    message_ids,
                    read_at: new Date()
                });
            }
        } catch (error) {
            console.error('Ошибка при отметке сообщений как прочитанных:', error);
        }
    });
    
    socket.on('sendMessage', async (message) => {
        const { conversation_id, sender_id, content, mentions = [] } = message;

        try {
            // Сохраняем сообщение и получаем его данные
            const savedMessage = await saveMessage(conversation_id, sender_id, content, mentions);
            console.log('Отправка сообщения: ');
            console.log(savedMessage);

            // Отправляем сообщение всем участникам разговора
            io.to(conversation_id).emit('newMessage', savedMessage );

            // Получаем всех участников разговора с помощью новой функции
            const participants = await fetchAllParticipantsByConversationIdForMessages(conversation_id);
            if (!participants) throw new Error('Не удалось получить участников');
            const memberIds = participants.map((p: any) => p.user_id);

            // Отмечаем сообщение как прочитанное для отправителя
            await pool.query(
                `
                INSERT INTO message_reads (message_id, user_id, read_at)
                VALUES ($1, $2, NOW())
                ON CONFLICT (message_id, user_id) DO NOTHING
                `,
                [savedMessage.id, sender_id]
            );

            // Отправляем обновление статуса прочтения всем участникам
            io.to(conversation_id).emit('messageRead', {
                message_id: savedMessage.id,
                user_id: sender_id,
                read_at: new Date()
            });

            // Отправляем уведомления всем участникам (кроме отправителя)
            memberIds.forEach((memberId: string) => {
                if (memberId !== sender_id) {
                    io.to(memberId).emit('notification', {
                        type: 'new_message',
                        content: `Новое сообщение от ${savedMessage.sender_id}`,
                        related_conversation_id: conversation_id,
                        related_message_id: savedMessage.id
                    });
                }
            });

            // Отправляем уведомления об упоминаниях
            if (mentions.length > 0) {
                mentions.forEach((mentionedUserId: string) => {
                    io.to(mentionedUserId).emit('notification', {
                        type: 'mention',
                        content: `Вас упомянули в сообщении от ${savedMessage.sender_id}`,
                        related_conversation_id: conversation_id,
                        related_message_id: savedMessage.id
                    });
                });
            }

        } catch (err) {
            console.error('Не удалось сохранить сообщение:', err);
        }
    });

    socket.on('disconnect', async () => {
        console.log('Пользователь отключился: ', socket.id);
        
        try {
            const userId = userSockets.get(socket.id);
            if (userId) {
                // Удаляем соответствие socket.id и userId
                userSockets.delete(socket.id);
                
                // Обновляем статус пользователя на офлайн
                await updateUserOnlineStatus(userId, false);
                
                // Уведомляем всех о том, что пользователь офлайн
                io.emit('userStatusChanged', { userId, isOnline: false });
                
                console.log(`Пользователь ${userId} отмечен как офлайн`);
            }
        } catch (error) {
            console.error('Ошибка при обработке отключения пользователя:', error);
        }
    });
});
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT) || 6000;

server.listen(PORT, HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);
});