import express, { Request, Response } from 'express';
import { json } from 'body-parser';
import authRoutes from './routes/authRoutes';
import conversationsRoutes from './routes/conversationsRoutes';
import messagesRoutes from './routes/messagesRoutes';
import filesRoutes from './routes/filesRoutes';
import contactsRoutes from './routes/contactsRoutes';
import taskRoutes from './routes/taskRoutes';
import usersRoutes from './routes/usersRoutes';
import avatarRoutes from './routes/avatarRoutes';
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
// Создаем папку uploads/avatars, если она не существует
const avatarUploadsDir = path.join(uploadsDir, 'avatars');
if (!fs.existsSync(avatarUploadsDir)) {
    fs.mkdirSync(avatarUploadsDir, { recursive: true });
    console.log('Папка uploads/avatars создана');
}
// Создаем папку uploads/group_avatars, если она не существует
const groupAvatarUploadsDir = path.join(uploadsDir, 'group_avatars');
if (!fs.existsSync(groupAvatarUploadsDir)) {
    fs.mkdirSync(groupAvatarUploadsDir, { recursive: true });
    console.log('Папка uploads/group_avatars создана');
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

// Обслуживаем все папки внутри uploads статически
app.use('/uploads', express.static(uploadsDir));
// Старая версия (только /uploads):
// app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.use('/auth', authRoutes);
app.use('/conversations', conversationsRoutes);
app.use('/messages', messagesRoutes);
app.use('/contacts', contactsRoutes);
app.use('/files', filesRoutes);
app.use('/tasks', taskRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/avatars', avatarRoutes);

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
            const userDetails = await pool.query('SELECT username, ua.file_path AS "avatarUrl" FROM users u LEFT JOIN user_avatars ua ON u.id = ua.user_id WHERE u.id = $1', [userId]);
            const statusPayload = {
                 userId, 
                 isOnline: true,
                 // avatarUrl: userDetails.rows.length > 0 ? (userDetails.rows[0].avatarUrl || null) : null // Optionally add avatar here too
            };
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
            // Получаем всех участников чата
            const participants = await fetchAllParticipantsByConversationIdForMessages(conversationId);
            // Fetch reader's avatar
            const readerDetails = await pool.query('SELECT ua.file_path AS "avatarUrl" FROM user_avatars ua WHERE ua.user_id = $1', [userId]);
            const readerAvatarUrl = readerDetails.rows.length > 0 ? (readerDetails.rows[0].avatarUrl || null) : null;

            if (participants) {
                // Уведомляем всех участников о прочтении сообщений через сервис
                const messagesReadPayload = {
                    conversation_id: conversationId,
                    user_id: userId,
                    avatarUrl: readerAvatarUrl, // Add reader's avatar URL
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

            // Fetch reader's avatar
            const readerDetailsMark = await pool.query('SELECT ua.file_path AS "avatarUrl" FROM user_avatars ua WHERE ua.user_id = $1', [userId]);
            const readerAvatarUrlMark = readerDetailsMark.rows.length > 0 ? (readerDetailsMark.rows[0].avatarUrl || null) : null;

            // Уведомляем всех участников о прочтении сообщений через сервис
            const markReadPayload = {
                conversation_id,
                user_id: userId,
                avatarUrl: readerAvatarUrlMark, // Add reader's avatar URL
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
             const authErrorPayload = { message: 'Authentication mismatch or user not authenticated.' };
             socket.emit('sendMessage_failed', authErrorPayload);
             return;
        }
        // Деструктурируем message, ожидая fileIds (массив)
        const { conversation_id, sender_id, content, mentions = [], fileIds = [], replied_to_message_id } = message; // Изменено file_id на fileIds

        // Валидация: должно быть либо сообщение, либо файл(ы)
        if (!content && (!fileIds || fileIds.length === 0)) { // Проверка на пустой массив fileIds
            console.warn(`Attempt to send empty message (no content or files) from user ${userId} in conversation ${conversation_id}`);
            const validationErrorPayload = { message: 'Message content or files cannot be empty.', originalMessage: message }; // Обновлен текст ошибки
            socket.emit('sendMessage_failed', validationErrorPayload);
            return;
        }

        try {
            // Сохраняем сообщение, передавая fileIds
            const savedMessage = await saveMessage(
                conversation_id,
                sender_id,
                content || '',
                mentions,
                fileIds, // Передаем массив fileIds
                replied_to_message_id
            );
            console.log(`User ${sender_id} sending message to conversation ${conversation_id}. Files: ${fileIds.length}, Reply to: ${replied_to_message_id || 'none'}`);

            // Отправляем полное сохраненное сообщение (уже содержит все поля)
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
                 // Fetch reader's avatar for self-read update
                 const readerDetailsSelf = await pool.query('SELECT ua.file_path AS "avatarUrl" FROM user_avatars ua WHERE ua.user_id = $1', [sender_id]);
                 const readerAvatarUrlSelf = readerDetailsSelf.rows.length > 0 ? (readerDetailsSelf.rows[0].avatarUrl || null) : null;

                 const messageReadPayload = {
                     conversation_id: conversation_id, // Добавляем ID чата
                     message_id: savedMessage.id,
                     user_id: sender_id,
                     avatarUrl: readerAvatarUrlSelf, // Add reader's avatar URL
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
                    const offlinePayload = {
                         userId, 
                         isOnline: false,
                         // avatarUrl: null // Optionally include avatar here? 
                        };
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