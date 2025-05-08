import { Socket } from 'socket.io';
import knex from '../../lib/knex';
import { emitToRoom, userSockets } from './socketService';
import { ROOM_PREFIXES } from '../../config/constants';
import { isValidUUID, socketTaskRooms } from './socketUtils';

export async function handleJoinTaskDetails(socket: Socket, taskId: string, join: boolean): Promise<void> {
    const userId = userSockets.get(socket.id);
    if (!userId) {
        console.warn(JSON.stringify({
            event: join ? 'joinTaskDetails' : 'leaveTaskDetails',
            socketId: socket.id,
            taskId,
            status: 'failed',
            reason: 'Unauthenticated socket',
        }));
        return;
    }

    if (!isValidUUID(taskId)) {
        console.warn(JSON.stringify({
            event: join ? 'joinTaskDetails' : 'leaveTaskDetails',
            userId,
            taskId,
            status: 'failed',
            reason: 'Invalid task ID format',
        }));
        return;
    }

    const roomName = `${ROOM_PREFIXES.TASK}${taskId}`;
    if (join) {
        socket.join(roomName);
        socketTaskRooms.get(socket.id)?.add(taskId);

        const task = await knex('tasks')
            .select('id', 'title', 'status', 'created_at', 'updated_at')
            .where('id', taskId)
            .first();

        if (task) {
            emitToRoom(roomName, 'taskStatus', {
                taskId,
                title: task.title,
                status: task.status,
                created_at: new Date(task.created_at).toISOString(),
                updated_at: new Date(task.updated_at).toISOString(),
            });
        }
    } else {
        socket.leave(roomName);
        socketTaskRooms.get(socket.id)?.delete(taskId);
    }
    console.log(JSON.stringify({
        event: join ? 'joinTaskDetails' : 'leaveTaskDetails',
        userId,
        taskId,
        status: 'success',
    }));
}