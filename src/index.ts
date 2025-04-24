import express, { Request, Response } from 'express';
import { json } from 'body-parser';
import authRoutes from './routes/authRoutes';
import conversationsRoutes from './routes/conversationsRoutes';
import messagesRoutes from './routes/messagesRoutes';
import filesRoutes from './routes/filesRoutes';
import contactsRoutes from './routes/contactsRoutes';
import taskRoutes from './routes/taskRoutes';
import usersRoutes from './routes/usersRoutes';
import http from 'http';
import { Server, Socket } from 'socket.io';
import { saveMessage } from './controllers/messagesController'; // Import saveMessage
import pool from './models/db';
import { fetchAllParticipantsByConversationId, fetchAllParticipantsByConversationIdForMessages } from './controllers/conversationController';
import { updateUserOnlineStatus } from './controllers/userController';
import fs from 'fs';
import path from 'path';
import * as socketService from './services/socketService'; // Импортируем сервис

// Создаем папку uploads, если она не существует
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    console.log('Папка uploads создана');
}

const app = express();
const server = http.createServer(app);
app.use(json());
// Убираем export, инициализируем io как локальную переменную
const io = new Server(server, {
    cors: {
        origin: '*',
    },
});

// Инициализируем сервис Socket.IO
socketService.initializeSocketService(io);

app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.use('/auth', authRoutes);
app.use('/conversations', conversationsRoutes);
app.use('/messages', messagesRoutes);
app.use('/contacts', contactsRoutes);
app.use('/files', filesRoutes);
app.use('/tasks', taskRoutes);
app.use('/api/users', usersRoutes);

app.get('/', (req: Request, res: Response) => {
    console.log("test");
    res.send("yes it works");
});

// Хранилище для сопоставления socket.id и userId
const userSockets = new Map<string, string>();
// Хранилище для отслеживания комнат задач, к которым присоединился сокет
const socketTaskRooms = new Map<string, Set<string>>();

io.on('connection', async (socket: Socket) => {
    console.log('Пользователь подключился: ', socket.id);

    // Обработка аутентификации пользователя
    socket.on('authenticate', async (userId: string) => {
        try {
            // TODO: Implement proper token validation here instead of directly trusting userId
            console.log(`Attempting to authenticate user ${userId} for socket ${socket.id}`);
            // Сохраняем соответствие socket.id и userId
            userSockets.set(socket.id, userId);
            socketTaskRooms.set(socket.id, new Set<string>()); // Initialize task rooms set for the socket

            // Автоматически присоединяем к личной комнате
            const userRoom = `user_${userId}`;
            socket.join(userRoom);
            console.log(`Socket ${socket.id} joined personal room: ${userRoom}`);

            // Автоматически присоединяем к общей комнате задач
            socket.join('general_tasks');
            console.log(`Socket ${socket.id} joined room: general_tasks`);

            // Обновляем статус пользователя на онлайн
            await updateUserOnlineStatus(userId, true);

            // Уведомляем всех о том, что пользователь онлайн через сервис
            const statusPayload = { userId, isOnline: true };
            socketService.emitToAll('userStatusChanged', statusPayload);

            console.log(`Пользователь ${userId} аутентифицирован, отмечен как онлайн и присоединен к комнатам.`);
        } catch (error: any) {
            console.error(`Ошибка при аутентификации пользователя ${userId} для сокета ${socket.id}:`, error);
            // Optionally emit an authentication error back to the client
            const authErrorPayload = { message: error.message || 'Authentication failed' };
            console.log(`[Socket Emit] Event: authentication_failed | Target: Socket ${socket.id}`);
            socket.emit('authentication_failed', authErrorPayload);
        }
    });

    socket.on('joinConversation', async (conversationId) => {
        const userId = userSockets.get(socket.id);
        if (!userId) {
            console.warn(`Socket ${socket.id} tried to join conversation ${conversationId} without authentication.`);
            return; // Ignore if not authenticated
        }
        socket.join(conversationId);
        console.log(`User ${userId} (Socket ${socket.id}) joined conversation: ${conversationId}`);

        try {
            // Отмечаем все сообщения в чате как прочитанные
            // await pool.query(
            //     `
            //     INSERT INTO message_reads (message_id, user_id, read_at)
            //     SELECT m.id, $1, NOW()
            //     FROM messages m
            //     WHERE m.conversation_id = $2
            //     AND NOT EXISTS (
            //         SELECT 1 
            //         FROM message_reads mr 
            //         WHERE mr.message_id = m.id 
            //         AND mr.user_id = $1
            //     )
            //     `,
            //     [userId, conversationId]
            // );

            // Получаем всех участников чата
            const participants = await fetchAllParticipantsByConversationIdForMessages(conversationId);
            if (participants) {
                // Уведомляем всех участников о прочтении сообщений через сервис
                const messagesReadPayload = {
                    conversation_id: conversationId,
                    user_id: userId,
                    read_at: new Date()
                };
                socketService.emitToRoom(conversationId, 'messagesRead', messagesReadPayload);
            }
        } catch (error: any) {
            console.error(`Error processing message read for user ${userId} in conversation ${conversationId}:`, error);
        }
    });

    // Добавляем новый обработчик для прочтения сообщений
    socket.on('markMessagesAsRead', async ({ conversation_id, message_ids }) => {
        const userId = userSockets.get(socket.id);
        if (!userId) {
            console.warn(`Socket ${socket.id} tried to mark messages as read without authentication.`);
            return; // Ignore if not authenticated
        }
        try {
            // Отмечаем указанные сообщения как прочитанные
            await pool.query(
                `
                INSERT INTO message_reads (message_id, user_id, read_at)
                SELECT unnest($1::uuid[]), $2, NOW()
                ON CONFLICT (message_id, user_id) DO NOTHING
                `,
                [message_ids, userId]
            );

            // Уведомляем всех участников о прочтении сообщений через сервис
            const markReadPayload = {
                conversation_id,
                user_id: userId,
                message_ids,
                read_at: new Date()
            };
            socketService.emitToRoom(conversation_id, 'messagesRead', markReadPayload);
            console.log(`User ${userId} marked messages ${message_ids} as read in conversation ${conversation_id}`);
        } catch (error: any) {
            console.error(`Error marking messages as read for user ${userId}:`, error);
        }
    });

    socket.on('sendMessage', async (message) => {
        const userId = userSockets.get(socket.id);
        if (!userId || userId !== message.sender_id) {
             console.warn(`Auth mismatch or unauthenticated socket ${socket.id} tried to send message:`, message);
             // Возможно, стоит отправить ошибку отправителю
             const authErrorPayload = { message: 'Authentication mismatch or user not authenticated.' };
             socket.emit('sendMessage_failed', authErrorPayload);
             return;
        }
        // Деструктурируем новые поля из сообщения
        const { conversation_id, sender_id, content, mentions = [], file_id, replied_to_message_id } = message; // Добавили replied_to_message_id

        // Простая валидация: должно быть либо сообщение, либо файл
        if (!content && !file_id) {
            console.warn(`Attempt to send empty message from user ${userId} in conversation ${conversation_id}`);
            const validationErrorPayload = { message: 'Message content or file cannot be empty.', originalMessage: message };
            socket.emit('sendMessage_failed', validationErrorPayload);
            return;
        }

        try {
            // Сохраняем сообщение, передавая replied_to_message_id
            const savedMessage = await saveMessage(
                conversation_id,
                sender_id,
                content || '', // Передаем пустую строку, если content отсутствует (например, при отправке только файла)
                mentions,
                file_id,
                replied_to_message_id // Передаем ID сообщения для ответа
            );
            console.log(`User ${sender_id} sending message to conversation ${conversation_id}. Reply to: ${replied_to_message_id || 'none'}`);
            // console.log(savedMessage); // savedMessage уже содержит все нужные поля, включая данные ответа и is_edited=false

            // Отправляем полное сохраненное сообщение всем участникам разговора через сервис
            // Оно уже включает replied_to_*, is_edited и т.д.
            socketService.emitToRoom(conversation_id, 'newMessage', savedMessage);

            // Получаем всех участников разговора (если нужно для дополнительной логики, но для уведомлений ниже не обязательно)
            const participants = await fetchAllParticipantsByConversationIdForMessages(conversation_id);
            if (!participants) throw new Error('Не удалось получить участников');
            const memberIds = participants.map((p: any) => p.user_id);

            // Отправляем уведомления всем участникам (кроме отправителя) через сервис
            memberIds.forEach((memberId: string) => {
                if (memberId !== sender_id) {
                     const notificationPayload = {
                        type: 'new_message',
                        content: `Новое сообщение от ${savedMessage.sender_username || sender_id}`,
                        related_conversation_id: conversation_id,
                        related_message_id: savedMessage.id
                    };
                     socketService.emitToUser(memberId, 'notification', notificationPayload);
                }
            });

            // Отправляем уведомления об упоминаниях
            if (mentions.length > 0) {
                mentions.forEach((mentionedUserId: string) => {
                    // Убедимся, что не отправляем уведомление об упоминании самому себе
                    if (mentionedUserId !== sender_id) {
                        const mentionPayload = {
                            type: 'mention',
                            content: `Вас упомянули в сообщении от ${savedMessage.sender_username || sender_id}`,
                            related_conversation_id: conversation_id,
                            related_message_id: savedMessage.id
                        };
                        socketService.emitToUser(mentionedUserId, 'notification', mentionPayload);
                    }
                });
            }

             // Отметка о прочтении для отправителя и рассылка статуса прочтения всем
             // (Перенес из saveMessage, так как там это не очень логично)
             try {
                 await pool.query(
                     `
                     INSERT INTO message_reads (message_id, user_id, read_at)
                     VALUES ($1, $2, NOW())
                     ON CONFLICT (message_id, user_id) DO NOTHING
                     `,
                     [savedMessage.id, sender_id]
                 );
                 // Отправляем обновление статуса прочтения всем участникам через сервис
                 const messageReadPayload = {
                     conversation_id: conversation_id, // Добавляем ID чата
                     message_id: savedMessage.id,
                     user_id: sender_id,
                     read_at: new Date().toISOString() // Используем ISO строку для консистентности
                 };
                 socketService.emitToRoom(conversation_id, 'messageReadUpdate', messageReadPayload); // Используем другое событие, чтобы не путать с messagesRead

             } catch(readErr) {
                 console.error(`Failed to mark message ${savedMessage.id} as read for sender ${sender_id}:`, readErr);
                 // Не прерываем основной процесс
             }

        } catch (err: any) {
            console.error(`Failed to save or send message from user ${userId}:`, err);
            // Отправляем ошибку отправителю
            const sendErrorPayload = { message: err.message || 'Failed to send message', originalMessage: message };
            console.log(`[Socket Emit] Event: sendMessage_failed | Target: Socket ${socket.id}`);
            socket.emit('sendMessage_failed', sendErrorPayload);
        }
    });

    // >>> Existing typing indicators <<<
    socket.on('start_typing', ({ conversation_id, user_id }) => {
        const authenticatedUserId = userSockets.get(socket.id);
        if (!authenticatedUserId || authenticatedUserId !== user_id) {
            console.warn(`Auth mismatch or unauthenticated socket ${socket.id} tried to send start_typing`);
            return;
        }
        console.log(`User ${user_id} started typing in conversation ${conversation_id}`);
        const typingPayload = { conversation_id, user_id };
        console.log(`[Socket Emit] Event: user_typing | Target: Room ${conversation_id} (excluding sender ${socket.id})`);
        socket.to(conversation_id).emit('user_typing', typingPayload);
    });

    socket.on('stop_typing', ({ conversation_id, user_id }) => {
        const authenticatedUserId = userSockets.get(socket.id);
        if (!authenticatedUserId || authenticatedUserId !== user_id) {
            console.warn(`Auth mismatch or unauthenticated socket ${socket.id} tried to send stop_typing`);
            return;
        }
        console.log(`User ${user_id} stopped typing in conversation ${conversation_id}`);
        const stopTypingPayload = { conversation_id, user_id };
        console.log(`[Socket Emit] Event: user_stopped_typing | Target: Room ${conversation_id} (excluding sender ${socket.id})`);
        socket.to(conversation_id).emit('user_stopped_typing', stopTypingPayload);
    });
    // >>> End typing indicators <<<

    // --- Task Room Management ---
    socket.on('joinTaskDetails', (taskId: string) => {
        const userId = userSockets.get(socket.id);
        if (!userId) {
             console.warn(`Unauthenticated socket ${socket.id} tried to join task room ${taskId}`);
             return;
        }
        const roomName = `task_${taskId}`;
        socket.join(roomName);
        socketTaskRooms.get(socket.id)?.add(taskId); // Track joined task room
        console.log(`User ${userId} (Socket ${socket.id}) joined task room: ${roomName}`);
    });

    socket.on('leaveTaskDetails', (taskId: string) => {
        const userId = userSockets.get(socket.id);
         if (!userId) {
             console.warn(`Unauthenticated socket ${socket.id} tried to leave task room ${taskId}`);
             return;
         }
        const roomName = `task_${taskId}`;
        socket.leave(roomName);
        socketTaskRooms.get(socket.id)?.delete(taskId); // Untrack task room
        console.log(`User ${userId} (Socket ${socket.id}) left task room: ${roomName}`);
    });
    // --- End Task Room Management ---

    socket.on('disconnect', async (reason) => {
        console.log(`Пользователь отключился: ${socket.id}, причина: ${reason}`);

        const userId = userSockets.get(socket.id);
        if (userId) {
            // Пользователь был аутентифицирован
            try {
                // Покидаем все комнаты задач, к которым присоединялся сокет
                const taskRooms = socketTaskRooms.get(socket.id);
                if (taskRooms) {
                    taskRooms.forEach(taskId => {
                        const roomName = `task_${taskId}`;
                        socket.leave(roomName);
                        console.log(`Socket ${socket.id} automatically left task room ${roomName} on disconnect`);
                    });
                }

                // Покидаем личную комнату и общую комнату задач (Socket.IO может делать это автоматически, но для явности)
                socket.leave(`user_${userId}`);
                socket.leave('general_tasks');
                console.log(`Socket ${socket.id} left rooms user_${userId} and general_tasks on disconnect.`);

                // Удаляем данные о сокете
                userSockets.delete(socket.id);
                socketTaskRooms.delete(socket.id);

                // Проверяем, остались ли другие активные сокеты у этого пользователя
                let hasOtherConnections = false;
                // Convert iterator to array to avoid downlevelIteration issue
                const connectedUserIds = Array.from(userSockets.values());
                for (const uid of connectedUserIds) { // Iterate over the array
                    if (uid === userId) {
                        hasOtherConnections = true;
                        break;
                    }
                }

                // Обновляем статус на оффлайн только если нет других активных соединений
                if (!hasOtherConnections) {
                    await updateUserOnlineStatus(userId, false);
                    const offlinePayload = { userId, isOnline: false };
                    socketService.emitToAll('userStatusChanged', offlinePayload); // Используем сервис
                    console.log(`Пользователь ${userId} отмечен как офлайн (last connection closed).`);
                } else {
                    console.log(`Пользователь ${userId} все еще онлайн (other connections exist).`);
                }

            } catch (error: any) {
                console.error(`Ошибка при обработке отключения пользователя ${userId} (Socket ${socket.id}):`, error);
            }
        } else {
            // Сокет не был аутентифицирован, просто лог
            console.log(`Unauthenticated socket ${socket.id} disconnected.`);
        }
    });
});

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT) || 6000;

server.listen(PORT, HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);
});