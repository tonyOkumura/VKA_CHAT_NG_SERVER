import { Server, Socket } from 'socket.io';
import { handleAuthenticate } from './socket/authSocket';
import { handleContactAdded } from './socket/contactSocket';
import { handleJoinDialog } from './socket/dialogSocket';
import { handleJoinGroup } from './socket/groupSocket';
import { handleSendMessage, handleEditMessage, handleMarkMessagesAsRead, handleTyping } from './socket/messageSocket';
import { handleJoinTaskDetails } from './socket/taskSocket';
import { handleNotification, handleDeleteAccount, handleDisconnect } from './socket/userSocket';
import { MessageData, MarkMessagesAsReadData, NotificationData, ContactAddedData, TypingData } from './socket/socketUtils';

export function setupSocketHandlers(io: Server): void {
    io.on('connection', (socket: Socket) => {
        console.log(`User connected: ${socket.id}`);

        socket.on('authenticate', async (token: string) => handleAuthenticate(socket, token));
        socket.on('joinDialog', async (dialogId: string) => handleJoinDialog(socket, dialogId));
        socket.on('joinGroup', async (groupId: string) => handleJoinGroup(socket, groupId));
        socket.on('markMessagesAsRead', async (data: MarkMessagesAsReadData) =>
            handleMarkMessagesAsRead(socket, data));
        socket.on('sendMessage', async (message: MessageData) => handleSendMessage(socket, message));
        socket.on('editMessage', async (data: { message_id: string; content: string }) =>
            handleEditMessage(socket, data));
        socket.on('start_typing', (data: TypingData) => handleTyping(socket, data, true));
        socket.on('stop_typing', (data: TypingData) => handleTyping(socket, data, false));
        socket.on('joinTaskDetails', (taskId: string) => handleJoinTaskDetails(socket, taskId, true));
        socket.on('leaveTaskDetails', (taskId: string) => handleJoinTaskDetails(socket, taskId, false));
        socket.on('notification', async (data: NotificationData) => handleNotification(socket, data));
        socket.on('contactAdded', async (data: ContactAddedData) => handleContactAdded(socket, data));
        socket.on('deleteAccount', async () => handleDeleteAccount(socket, io));
        socket.on('disconnect', async (reason: string) => handleDisconnect(socket, reason));
    });
}