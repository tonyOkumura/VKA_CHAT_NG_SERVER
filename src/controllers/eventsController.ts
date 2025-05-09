import { Request, Response } from 'express';
import knex from '../lib/knex';
import * as socketService from '../services/socket/socketService';
import { getUserDetailsWithAvatar } from '../lib/dbHelpers';
import { v4 as uuidv4 } from 'uuid';

// TODO: Define valid event statuses (e.g., 'planned', 'ongoing', 'completed', 'cancelled')
const VALID_EVENT_STATUSES = ['planned', 'ongoing', 'completed', 'cancelled'];
// TODO: Define valid participant statuses (e.g., 'invited', 'accepted', 'declined', 'maybe')
const VALID_PARTICIPANT_STATUSES = ['invited', 'accepted', 'declined', 'maybe'];

interface EventParticipant {
    user_id: string;
    username: string;
    avatarPath: string | null;
    status: string;
    // Add other relevant fields from users table if needed
}

interface FullEventDetails {
    id: string;
    title: string;
    description: string | null;
    creator_id: string;
    creator_username: string | null;
    creator_avatar_path: string | null;
    group_id: string | null;
    dialog_id: string | null;
    budget: number | null;
    start_time: string;
    end_time: string;
    location: string | null;
    status: string;
    created_at: string;
    updated_at: string;
    participants: EventParticipant[];
}

interface DeletedEventInfo {
    id: string;
    participants: { user_id: string }[];
    group_id: string | null;
    dialog_id: string | null;
}

interface UpdatedParticipantInfo {
    event_id: string;
    user_id: string;
    status: string;
}

interface RemovedParticipantInfo {
    eventId: string;
    userId: string;
}

// Helper function to fetch full event details
async function fetchFullEventDetails(eventId: string): Promise<FullEventDetails | null> {
    const event = await knex('events')
        .select(
            'events.*',
            'creator.username as creator_username',
            'creator.avatar_path as creator_avatar_path'
        )
        .join('users as creator', 'events.creator_id', 'creator.id')
        .where('events.id', eventId)
        .first();

    if (!event) {
        return null;
    }

    const participantsData = await knex('event_participants as ep')
        .join('users as u', 'ep.user_id', 'u.id')
        .select('u.id as user_id', 'u.username', 'u.avatar_path', 'ep.status')
        .where('ep.event_id', eventId);

    const participants: EventParticipant[] = participantsData.map(p => ({
        user_id: p.user_id,
        username: p.username,
        avatarPath: p.avatar_path,
        status: p.status,
    }));

    return {
        ...event,
        start_time: new Date(event.start_time).toISOString(),
        end_time: new Date(event.end_time).toISOString(),
        created_at: new Date(event.created_at).toISOString(),
        updated_at: new Date(event.updated_at).toISOString(),
        participants,
    };
}

// Helper function to check if a user is a participant or creator of an event
async function checkEventAccess(userId: string, eventId: string): Promise<boolean> {
    const event = await knex('events')
        .select('creator_id')
        .where('id', eventId)
        .first();

    if (!event) return false; // Event doesn't exist
    if (event.creator_id === userId) return true; // User is the creator

    const participant = await knex('event_participants')
        .where({ event_id: eventId, user_id: userId })
        .first();

    return !!participant; // User is a participant
}

// --- Event CRUD ---

export const createEvent = async (req: Request, res: Response): Promise<void> => {
    const creator_id = req.user?.id;
    const {
        title,
        description,
        group_id, // Optional: link to a group
        dialog_id, // Optional: link to a dialog (exclusive with group_id)
        budget,
        start_time,
        end_time,
        location,
        status = 'planned',
        participant_ids = [] // Optional: initial list of user IDs to invite
    } = req.body;

    if (!creator_id) {
        res.status(401).json({ error: 'Пользователь не авторизован' });
        return;
    }
    if (!title || !start_time || !end_time) {
        res.status(400).json({ error: 'Название, время начала и время окончания обязательны' });
        return;
    }
    if (group_id && dialog_id) {
        res.status(400).json({ error: 'Событие может быть связано либо с группой, либо с диалогом, но не с обоими одновременно' });
        return;
    }
    if (!VALID_EVENT_STATUSES.includes(status)) {
        res.status(400).json({ error: `Недопустимый статус события. Допустимые значения: ${VALID_EVENT_STATUSES.join(', ')}` });
        return;
    }
    try {
        new Date(start_time);
        new Date(end_time);
    } catch (e) {
        res.status(400).json({ error: 'Неверный формат времени начала или окончания.' });
        return;
    }

    try {
        const newEventId = uuidv4();
        await knex.transaction(async (trx) => {
            await trx('events').insert({
                id: newEventId,
                title,
                description,
                creator_id,
                group_id: group_id || null,
                dialog_id: dialog_id || null,
                budget: budget || null,
                start_time: new Date(start_time),
                end_time: new Date(end_time),
                location,
                status,
            });

            // Add creator as a participant with 'accepted' status
            const participantEntries = [{
                event_id: newEventId,
                user_id: creator_id,
                status: 'accepted', // Creator auto-accepts
            }];

            // Add other initial participants as 'invited'
            if (Array.isArray(participant_ids)) {
                for (const pId of participant_ids) {
                    if (pId !== creator_id) { // Avoid duplicate if creator is in participant_ids
                        // Ensure participant exists (optional, DB foreign key will catch it too)
                        const userExists = await trx('users').where('id', pId).first();
                        if (userExists) {
                            participantEntries.push({
                                event_id: newEventId,
                                user_id: pId,
                                status: 'invited',
                            });
                        } else {
                            console.warn(`User ID ${pId} not found, not adding as participant to event ${newEventId}`);
                        }
                    }
                }
            }
            if (participantEntries.length > 0) {
                await trx('event_participants').insert(participantEntries);
            }
        });

        const fullEvent = await fetchFullEventDetails(newEventId);

        if (!fullEvent) {
            // This should ideally not happen if transaction was successful
            console.error(`Failed to fetch newly created event ${newEventId} after transaction.`);
            res.status(500).json({ error: 'Событие создано, но не удалось получить его детали.' });
            return;
        }
        
        // Socket emissions
        // 1. To the creator
        socketService.emitToUser(creator_id, 'newEvent', fullEvent);
        // 2. To initially invited participants (excluding creator who auto-accepted)
        fullEvent.participants.forEach(participant => {
            if (participant.user_id !== creator_id && participant.status === 'invited') {
                socketService.emitToUser(participant.user_id, 'eventInvitation', fullEvent);
            }
        });
         // 3. If linked to a group or dialog, emit to that room (optional, depending on desired behavior)
        if (fullEvent.group_id) {
            socketService.emitToRoom(`GROUP${fullEvent.group_id}`, 'newEventInGroup', { eventId: fullEvent.id, title: fullEvent.title, groupId: fullEvent.group_id });
        } else if (fullEvent.dialog_id) {
            // Need to identify participants of the dialog to emit correctly
            const dialogParticipants = await knex('dialog_participants')
                .where('dialog_id', fullEvent.dialog_id)
                .select('user_id');
            dialogParticipants.forEach(dp => {
                 if(dp.user_id !== creator_id) { // Don't double-notify creator if they are part of dialog
                    socketService.emitToUser(dp.user_id, 'newEventInDialog', { eventId: fullEvent.id, title: fullEvent.title, dialogId: fullEvent.dialog_id });
                 }
            });
        }


        res.status(201).json(fullEvent);
        console.log(`Событие "${title}" (ID: ${newEventId}) создано пользователем ${creator_id}`);

    } catch (error: any) {
        console.error('Ошибка при создании события:', error);
        if (error.code === '23503') { // Foreign key violation
             if (error.constraint && error.constraint.includes('group_id')) {
                res.status(404).json({ error: 'Указанная группа не найдена.' });
            } else if (error.constraint && error.constraint.includes('dialog_id')) {
                res.status(404).json({ error: 'Указанный диалог не найден.' });
            } else {
                res.status(400).json({ error: 'Ошибка связи с другими данными (группа, диалог или пользователь).' });
            }
        } else {
            res.status(500).json({ error: 'Не удалось создать событие' });
        }
    }
};

export const getEvents = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id;
    if (!userId) {
        res.status(401).json({ error: 'Пользователь не авторизован' });
        return;
    }
    // TODO: Implement filtering (e.g., by status, date range)
    try {
        // Fetch events where the user is the creator or a participant
        const eventsData = await knex('events as e')
            .distinct('e.id') // Ensure unique events if user is both creator and participant
            .select(
                'e.*',
                'creator.username as creator_username',
                'creator.avatar_path as creator_avatar_path'
            )
            .leftJoin('event_participants as ep', 'e.id', 'ep.event_id')
            .join('users as creator', 'e.creator_id', 'creator.id')
            .where('e.creator_id', userId)
            .orWhere('ep.user_id', userId)
            .orderBy('e.start_time', 'desc'); // Example ordering

        // Optionally, fetch participant counts or other summary data here
        // This is a basic implementation; more details might be needed per event.
         const events = eventsData.map(event => ({
            ...event,
            start_time: new Date(event.start_time).toISOString(),
            end_time: new Date(event.end_time).toISOString(),
            created_at: new Date(event.created_at).toISOString(),
            updated_at: new Date(event.updated_at).toISOString(),
        }));


        res.status(200).json(events);
    } catch (error: any) {
        console.error('Ошибка при получении событий:', error);
        res.status(500).json({ error: 'Не удалось получить события' });
    }
};

export const getEventById = async (req: Request, res: Response): Promise<void> => {
    const { eventId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
        res.status(401).json({ error: 'Пользователь не авторизован' });
        return;
    }

    if (!eventId) {
        res.status(400).json({ error: 'Не указан ID события' });
        return;
    }

    try {
        const hasAccess = await checkEventAccess(userId, eventId);
        if (!hasAccess) {
             // Check if event exists before denying access
            const eventExists = await knex('events').where('id', eventId).first();
            if (!eventExists) {
                res.status(404).json({ error: 'Событие не найдено' });
            } else {
                res.status(403).json({ error: 'Доступ к этому событию запрещен' });
            }
            return;
        }

        const fullEvent = await fetchFullEventDetails(eventId);

        if (!fullEvent) {
            // Should be caught by hasAccess check, but added for safety
            res.status(404).json({ error: 'Событие не найдено' });
            return;
        }

        res.status(200).json(fullEvent);
        console.log(`Событие ${eventId} получено пользователем ${userId}`);

    } catch (error: any) {
        console.error(`Ошибка при получении события ${eventId}:`, error);
         if (error.code === '22P02') { // Invalid UUID format
            res.status(400).json({ error: 'Неверный формат ID события' });
        } else {
            res.status(500).json({ error: `Не удалось получить событие ${eventId}` });
        }
    }
};

export const updateEvent = async (req: Request, res: Response): Promise<void> => {
    const { eventId } = req.params;
    const userId = req.user?.id;
    const updates = req.body;

    if (!userId) {
        res.status(401).json({ error: 'Пользователь не авторизован' });
        return;
    }
    if (!eventId) {
        res.status(400).json({ error: 'Не указан ID события' });
        return;
    }
    if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'Нет данных для обновления' });
        return;
    }

    // --- Input Validation ---
    const allowedUpdates: (keyof FullEventDetails)[] = [
        'title', 'description', 'budget', 'start_time', 'end_time',
        'location', 'status' // Cannot change creator, group_id, dialog_id via this endpoint
    ];
    const updatesToApply: Partial<FullEventDetails> = {};

    for (const key in updates) {
        if (allowedUpdates.includes(key as keyof FullEventDetails)) {
            (updatesToApply as any)[key] = updates[key];
        }
    }

    if (Object.keys(updatesToApply).length === 0) {
        res.status(400).json({ error: 'Переданы недопустимые поля для обновления.' });
        return;
    }

    if (updatesToApply.status && !VALID_EVENT_STATUSES.includes(updatesToApply.status)) {
        res.status(400).json({ error: `Недопустимый статус события. Допустимые значения: ${VALID_EVENT_STATUSES.join(', ')}` });
        return;
    }

    if (updatesToApply.start_time) {
        try { new Date(updatesToApply.start_time); } catch (e) { res.status(400).json({ error: 'Неверный формат времени начала.' }); return; }
        updatesToApply.start_time = new Date(updatesToApply.start_time).toISOString(); // Standardize format for DB
    }
    if (updatesToApply.end_time) {
        try { new Date(updatesToApply.end_time); } catch (e) { res.status(400).json({ error: 'Неверный формат времени окончания.' }); return; }
         updatesToApply.end_time = new Date(updatesToApply.end_time).toISOString(); // Standardize format for DB
    }
    if (updatesToApply.start_time && updatesToApply.end_time && new Date(updatesToApply.start_time) >= new Date(updatesToApply.end_time)) {
        res.status(400).json({ error: 'Время начала не может быть позже или равно времени окончания.'});
        return;
    }

    // --- Update Logic ---
    try {
        const updatedEventData = await knex.transaction(async (trx) => {
            const currentEvent = await trx('events')
                .select('creator_id') // Add group/dialog admin check if needed
                .where('id', eventId)
                .first();

            if (!currentEvent) {
                throw { status: 404, message: 'Событие не найдено' };
            }

            // --- Permission Check --- Add more complex logic if needed (e.g., group/dialog admins)
            if (currentEvent.creator_id !== userId) {
                throw { status: 403, message: 'Только создатель может редактировать событие' };
            }
            // Ensure start/end time consistency if only one is provided
            if(updatesToApply.start_time && !updatesToApply.end_time) {
                const currentEndTime = await trx('events').select('end_time').where('id', eventId).first();
                if (new Date(updatesToApply.start_time) >= new Date(currentEndTime.end_time)) {
                    throw { status: 400, message: 'Время начала не может быть позже или равно текущему времени окончания.'};
                }
            }
             if(!updatesToApply.start_time && updatesToApply.end_time) {
                const currentStartTime = await trx('events').select('start_time').where('id', eventId).first();
                if (new Date(currentStartTime.start_time) >= new Date(updatesToApply.end_time)) {
                     throw { status: 400, message: 'Текущее время начала не может быть позже или равно новому времени окончания.'};
                }
            }

            // Apply updates
            updatesToApply.updated_at = new Date().toISOString();
            const updateCount = await trx('events')
                .where('id', eventId)
                .update(updatesToApply);

            if (updateCount === 0) {
                 // Should be caught earlier, but safety check
                 throw { status: 404, message: 'Событие не найдено во время обновления' };
            }
            
            // Fetch full details after update
            const fullUpdatedEvent = await fetchFullEventDetails(eventId);
            if (!fullUpdatedEvent) {
                 throw { status: 500, message: 'Ошибка получения деталей обновленного события.' };
            }
            return fullUpdatedEvent;
        });

        // Emit socket event to all participants
        if (updatedEventData && updatedEventData.participants) {
            updatedEventData.participants.forEach(participant => {
                socketService.emitToUser(participant.user_id, 'eventUpdated', updatedEventData);
            });
             // Also emit to group/dialog room if linked
            if (updatedEventData.group_id) {
                socketService.emitToRoom(`GROUP${updatedEventData.group_id}`, 'eventUpdatedInGroup', updatedEventData);
            }
             // Add similar logic for dialog_id if needed, fetching dialog participants
             else if (updatedEventData.dialog_id) {
                 const dialogParticipants = await knex('dialog_participants').where('dialog_id', updatedEventData.dialog_id).select('user_id');
                  dialogParticipants.forEach(dp => {
                        socketService.emitToUser(dp.user_id, 'eventUpdatedInDialog', updatedEventData);
                  });
             }
        }


        res.status(200).json(updatedEventData);
        console.log(`Событие ${eventId} обновлено пользователем ${userId}`);

    } catch (error: any) {
        console.error(`Ошибка при обновлении события ${eventId}:`, error);
        const status = error.status || 500;
        const message = error.message || 'Не удалось обновить событие';
         if (error.code === '22P02') {
            res.status(400).json({ error: 'Неверный формат ID события' });
        } else {
             res.status(status).json({ error: message });
        }
    }
};

export const deleteEvent = async (req: Request, res: Response): Promise<void> => {
    const { eventId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
        res.status(401).json({ error: 'Пользователь не авторизован' });
        return;
    }
     if (!eventId) {
        res.status(400).json({ error: 'Не указан ID события' });
        return;
    }

    try {
        let deletedEventData: DeletedEventInfo | null = null;

        await knex.transaction(async (trx) => {
            const event = await trx('events')
                .select('creator_id', 'group_id', 'dialog_id')
                .where('id', eventId)
                .first();

            if (!event) {
                throw { status: 404, message: 'Событие не найдено' };
            }

            // Permission Check: Only creator can delete
            if (event.creator_id !== userId) {
                throw { status: 403, message: 'Только создатель может удалить событие' };
            }

            // Fetch participants before deleting them for socket notification
             const participants = await trx('event_participants')
                .where('event_id', eventId)
                .select('user_id');

             // Assign here, inside the transaction where data is guaranteed if no error thrown yet
             deletedEventData = { id: eventId, participants, group_id: event.group_id, dialog_id: event.dialog_id };

            // Delete participants (cascade delete should handle this, but explicit is safer)
            await trx('event_participants').where('event_id', eventId).del();

            // Delete associated tasks (if implemented)
            // await trx('event_tasks').where('event_id', eventId).del();

            // Delete the event itself
            const deleteCount = await trx('events').where('id', eventId).del();

            if (deleteCount === 0) {
                // Should have been caught earlier, safety check
                throw { status: 404, message: 'Событие не найдено во время удаления' };
            }
        });

        // Emit socket event to former participants
        // Check explicitly if deletedEventData was assigned (i.e., transaction completed)
        if (deletedEventData) {
             // Use a new const for type narrowing within this block
            const eventInfo: DeletedEventInfo = deletedEventData;
            const payload = { eventId: eventInfo.id };

            eventInfo.participants.forEach(participant => {
                socketService.emitToUser(participant.user_id, 'eventDeleted', payload);
            });
             // Also notify linked group/dialog members (optional)
            if (eventInfo.group_id) {
                socketService.emitToRoom(`GROUP${eventInfo.group_id}`, 'eventDeletedInGroup', payload);
            }
             else if (eventInfo.dialog_id) {
                 const dialogParticipants = await knex('dialog_participants').where('dialog_id', eventInfo.dialog_id).select('user_id');
                  dialogParticipants.forEach(dp => {
                      // Avoid double-notifying if they were also direct event participants (already notified)
                      if (!eventInfo.participants.some(p => p.user_id === dp.user_id)) {
                         socketService.emitToUser(dp.user_id, 'eventDeletedInDialog', payload);
                      }
                  });
             }
        }

        res.status(200).json({ message: 'Событие успешно удалено', eventId: eventId });
        console.log(`Событие ${eventId} удалено пользователем ${userId}`);

    } catch (error: any) {
        console.error(`Ошибка при удалении события ${eventId}:`, error);
        const status = error.status || 500;
        const message = error.message || 'Не удалось удалить событие';
         if (error.code === '22P02') {
            res.status(400).json({ error: 'Неверный формат ID события' });
        } else {
             res.status(status).json({ error: message });
        }
    }
};

// --- Event Participant Management ---

export const addEventParticipant = async (req: Request, res: Response): Promise<void> => {
    const { eventId } = req.params;
    const { user_id_to_add, status = 'invited' } = req.body;
    const inviting_user_id = req.user?.id;

    if (!inviting_user_id) {
        res.status(401).json({ error: 'Пользователь не авторизован' });
        return;
    }
    if (!user_id_to_add) {
        res.status(400).json({ error: 'Необходимо указать user_id_to_add' });
        return;
    }
    if (!eventId) {
        res.status(400).json({ error: 'Не указан ID события' });
        return;
    }
     if (!VALID_PARTICIPANT_STATUSES.includes(status)) {
         res.status(400).json({ error: `Недопустимый статус участника. Допустимые значения: ${VALID_PARTICIPANT_STATUSES.join(', ')}` });
        return;
    }

    try {
        const newParticipantData = await knex.transaction(async (trx) => {
            const event = await trx('events')
                .select('creator_id') // Extend this if group/dialog admins can invite
                .where('id', eventId)
                .first();

            if (!event) {
                throw { status: 404, message: 'Событие не найдено' };
            }

            // --- Permission Check (Basic: Creator can invite) --- Refine as needed
            const isCreator = event.creator_id === inviting_user_id;
            // TODO: Add checks if participants can invite, or if group/dialog admins can
            if (!isCreator) {
                throw { status: 403, message: 'Только создатель может приглашать участников' }; // Adjust message later
            }

            // Check if target user exists
            const userToAdd = await trx('users').select('id', 'username', 'avatar_path').where('id', user_id_to_add).first();
            if (!userToAdd) {
                 throw { status: 404, message: 'Приглашаемый пользователь не найден' };
            }

            // Check if already a participant
            const existingParticipant = await trx('event_participants')
                .where({ event_id: eventId, user_id: user_id_to_add })
                .first();
            if (existingParticipant) {
                throw { status: 409, message: 'Пользователь уже является участником события' };
            }

            // Add participant
            await trx('event_participants').insert({
                event_id: eventId,
                user_id: user_id_to_add,
                status: status,
            });

            // Return details of the newly added participant
            return {
                event_id: eventId,
                user_id: userToAdd.id,
                username: userToAdd.username,
                avatarPath: userToAdd.avatar_path,
                status: status,
            };
        });

        // Fetch full event details to notify existing participants
        const fullEvent = await fetchFullEventDetails(eventId);

        // Socket emissions
        if (fullEvent) {
             // Notify existing participants about the new addition
             fullEvent.participants.forEach(p => {
                 if (p.user_id !== newParticipantData.user_id) { // Don't notify the new user with this generic event
                     socketService.emitToUser(p.user_id, 'eventParticipantAdded', { eventId: eventId, participant: newParticipantData });
                 }
             });
             // Notify the newly added user specifically (invitation)
              socketService.emitToUser(newParticipantData.user_id, 'eventInvitation', fullEvent);
        }

        res.status(201).json(newParticipantData);
        console.log(`Пользователь ${inviting_user_id} добавил участника ${user_id_to_add} к событию ${eventId} со статусом ${status}`);

    } catch (error: any) {
        console.error(`Ошибка при добавлении участника к событию ${eventId}:`, error);
        const status = error.status || 500;
        let message = error.message || 'Не удалось добавить участника к событию';
         if (error.code === '22P02') {
            message = 'Неверный формат ID события или пользователя';
        } else if (error.code === '23503') { // FK violation
             message = 'Событие или пользователь не найдены.';
        } else if (error.code === '23505') { // Unique constraint violation
            message = 'Пользователь уже является участником этого события.';
        }
         res.status(status).json({ error: message });
    }
};

export const getEventParticipants = async (req: Request, res: Response): Promise<void> => {
    const { eventId } = req.params;
    const userId = req.user?.id;

     if (!userId) {
        res.status(401).json({ error: 'Пользователь не авторизован' });
        return;
    }
     if (!eventId) {
        res.status(400).json({ error: 'Не указан ID события' });
        return;
    }

    try {
        // Check if user has access to the event first
        const hasAccess = await checkEventAccess(userId, eventId);
        if (!hasAccess) {
             const eventExists = await knex('events').where('id', eventId).first();
            if (!eventExists) {
                res.status(404).json({ error: 'Событие не найдено' });
            } else {
                 res.status(403).json({ error: 'Доступ к участникам этого события запрещен' });
            }
            return;
        }

        // Fetch participants with user details
        const participantsData = await knex('event_participants as ep')
            .join('users as u', 'ep.user_id', 'u.id')
            .select(
                'u.id as user_id',
                'u.username',
                'u.email',
                'u.avatar_path as avatarPath',
                'u.is_online',
                'ep.status',
                'ep.invited_at'
            )
            .where('ep.event_id', eventId)
            .orderBy('u.username'); // Or order by join time etc.
        
        const participants = participantsData.map(p => ({
            ...p,
            invited_at: new Date(p.invited_at).toISOString(),
        }));

        res.status(200).json(participants);
        console.log(`Участники события ${eventId} получены пользователем ${userId}`);

    } catch (error: any) {
        console.error(`Ошибка при получении участников события ${eventId}:`, error);
        if (error.code === '22P02') {
            res.status(400).json({ error: 'Неверный формат ID события' });
        } else {
            res.status(500).json({ error: `Не удалось получить участников события ${eventId}` });
        }
    }
};

export const updateEventParticipantStatus = async (req: Request, res: Response): Promise<void> => {
    const { eventId, participantUserId } = req.params; // participantUserId is the user whose status is changing
    const { status } = req.body;
    const currentUserId = req.user?.id; // The user initiating the status change

    if (!currentUserId) {
        res.status(401).json({ error: 'Пользователь не авторизован' });
        return;
    }
    if (!eventId || !participantUserId) {
        res.status(400).json({ error: 'Не указан ID события или ID участника' });
        return;
    }
    if (!status || !VALID_PARTICIPANT_STATUSES.includes(status)) {
        res.status(400).json({ error: `Необходимо указать допустимый статус. Допустимые значения: ${VALID_PARTICIPANT_STATUSES.join(', ')}` });
        return;
    }

    try {
        let updatedParticipantData: UpdatedParticipantInfo | null = null;

        await knex.transaction(async (trx) => {
            const event = await trx('events')
                .select('creator_id')
                .where('id', eventId)
                .first();

            if (!event) {
                throw { status: 404, message: 'Событие не найдено' };
            }

             const participantExists = await trx('event_participants')
                .where({ event_id: eventId, user_id: participantUserId })
                .first();

            if (!participantExists) {
                throw { status: 404, message: 'Участник не найден в этом событии' };
            }

            // --- Permission Check ---
            const canUpdate = (
                currentUserId === participantUserId || // User updating their own status
                currentUserId === event.creator_id    // Creator managing status (Use with caution for statuses like 'accepted')
                // TODO: Add check for group/dialog admins if applicable
            );

            if (!canUpdate) {
                 throw { status: 403, message: 'У вас нет прав на изменение статуса этого участника' };
            }

            // Update status
            const updateResult = await trx('event_participants')
                .where({ event_id: eventId, user_id: participantUserId })
                .update({ status: status })
                .returning(['event_id', 'user_id', 'status']);

            if (updateResult.length === 0) {
                 throw { status: 404, message: 'Не удалось найти участника для обновления статуса' };
            }
            updatedParticipantData = updateResult[0]; // Assign here
        });

        // Socket Emission
        if (updatedParticipantData) {
            const participantInfo: UpdatedParticipantInfo = updatedParticipantData; // Type narrowing
             // Fetch details of the user whose status changed for the payload
            const changedUserDetails = await getUserDetailsWithAvatar(participantInfo.user_id);
            const payload = {
                 eventId: participantInfo.event_id,
                 userId: participantInfo.user_id,
                 newStatus: participantInfo.status,
                 username: changedUserDetails?.username,
                 avatarPath: changedUserDetails?.avatarPath
            };
            // Notify all participants
            const allParticipants = await knex('event_participants').where('event_id', eventId).select('user_id');
            allParticipants.forEach(p => {
                 socketService.emitToUser(p.user_id, 'eventParticipantStatusUpdated', payload);
            });

             res.status(200).json({ 
                message: 'Статус участника успешно обновлен', 
                eventId: participantInfo.event_id, 
                userId: participantInfo.user_id, 
                newStatus: participantInfo.status
             });
            console.log(`Статус участника ${participantUserId} события ${eventId} обновлен на ${status} пользователем ${currentUserId}`);
        } else {
             // This case implies the transaction failed before assignment or updateResult was empty (caught inside)
            // Error should have been thrown and caught below, but good practice to handle unlikely scenarios.
            console.error('Transaction completed but updated participant info is missing.');
            res.status(500).json({ error: 'Внутренняя ошибка сервера после обновления статуса участника.' });
        }

    } catch (error: any) {
        console.error(`Ошибка при обновлении статуса участника ${participantUserId} события ${eventId}:`, error);
        const status = error.status || 500;
        let message = error.message || 'Не удалось обновить статус участника';
         if (error.code === '22P02') {
            message = 'Неверный формат ID события или пользователя';
        }
         res.status(status).json({ error: message });
    }
};

export const removeEventParticipant = async (req: Request, res: Response): Promise<void> => {
    const { eventId, participantUserId } = req.params; // participantUserId is the user being removed
    const currentUserId = req.user?.id; // The user initiating the removal

    if (!currentUserId) {
        res.status(401).json({ error: 'Пользователь не авторизован' });
        return;
    }
     if (!eventId || !participantUserId) {
        res.status(400).json({ error: 'Не указан ID события или ID участника' });
        return;
    }

    try {
        let removedInfoData: RemovedParticipantInfo | null = null;
        let remainingParticipants: {user_id: string}[] = [];

        await knex.transaction(async (trx) => {
            const event = await trx('events')
                .select('creator_id')
                .where('id', eventId)
                .first();

            if (!event) {
                throw { status: 404, message: 'Событие не найдено' };
            }

            const participantExists = await trx('event_participants')
                .where({ event_id: eventId, user_id: participantUserId })
                .first();

            if (!participantExists) {
                throw { status: 404, message: 'Участник не найден в этом событии' };
            }

            // --- Permission Check ---
            const canRemove = (
                currentUserId === participantUserId || // User leaving the event
                currentUserId === event.creator_id    // Creator removing someone
                // TODO: Add check for group/dialog admins if applicable
            );

            if (!canRemove) {
                 throw { status: 403, message: 'У вас нет прав на удаление этого участника' };
            }

            // Prevent creator from removing themselves this way? They should use deleteEvent?
             if (currentUserId === participantUserId && currentUserId === event.creator_id) {
                  throw { status: 400, message: 'Создатель не может покинуть событие этим способом. Используйте удаление события.' };
             }

            // Get remaining participants before deleting
            remainingParticipants = await trx('event_participants')
                                        .where('event_id', eventId)
                                        .andWhereNot('user_id', participantUserId)
                                        .select('user_id');

            // Remove participant
            const deleteCount = await trx('event_participants')
                .where({ event_id: eventId, user_id: participantUserId })
                .del();

             if (deleteCount === 0) {
                 throw { status: 404, message: 'Не удалось найти участника для удаления' };
            }
            removedInfoData = { eventId: eventId, userId: participantUserId }; // Assign here

            // If the creator is removed by someone else (future admin feature?), reassign?
            // Or if the last participant leaves, delete the event?
            // For now, just remove the participant.
        });

        // Socket Emissions
        if(removedInfoData) {
            const removedParticipantInfo: RemovedParticipantInfo = removedInfoData; // Type narrowing
            const payload = { eventId: removedParticipantInfo.eventId, userId: removedParticipantInfo.userId };
            // Notify remaining participants
            remainingParticipants.forEach(p => {
                 socketService.emitToUser(p.user_id, 'eventParticipantRemoved', payload);
            });
             // Notify the removed participant
             socketService.emitToUser(removedParticipantInfo.userId, 'removedFromEvent', { eventId: removedParticipantInfo.eventId });
        
             res.status(200).json({ 
                message: 'Участник успешно удален/вышел из события', 
                eventId: removedParticipantInfo.eventId,
                userId: removedParticipantInfo.userId
            });
            console.log(`Участник ${participantUserId} удален/вышел из события ${eventId} (инициировано ${currentUserId})`);
        } else {
             console.error('Transaction completed but removed participant info is missing.');
             res.status(500).json({ error: 'Внутренняя ошибка сервера после удаления участника.' });
        }

    } catch (error: any) {
        console.error(`Ошибка при удалении участника ${participantUserId} из события ${eventId}:`, error);
        const status = error.status || 500;
        let message = error.message || 'Не удалось удалить участника';
         if (error.code === '22P02') {
            message = 'Неверный формат ID события или пользователя';
        }
         res.status(status).json({ error: message });
    }
};

// TODO: Add functions for event tasks if linking tasks to events is required
// - linkTaskToEvent
// - unlinkTaskFromEvent
// - getEventTasks

