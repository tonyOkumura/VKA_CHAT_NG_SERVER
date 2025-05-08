import { Request, Response } from 'express';
import knex from '../lib/knex'; // Используем Knex
import * as socketService from '../services/socketService'; // Импортируем сервис

export const fetchContacts = async (req: Request, res: Response): Promise<any> => {
    const userId = req.user?.id;
    if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log(`Fetching contacts for user: ${userId}`);

    try {
        const contacts = await knex('contacts as c')
            .select(
                'u.id',
                'u.username',
                'u.email',
                'u.is_online',
                'ua.file_path as avatarPath'
            )
            .join('users as u', 'u.id', 'c.contact_id')
            .leftJoin('user_avatars as ua', 'u.id', 'ua.user_id')
            .where('c.user_id', userId)
            .orderBy('u.username', 'asc');

        console.log(`Contacts fetched successfully for user: ${userId}`);
        
        res.json(contacts);

    } catch (error) {
        console.error('Error fetching contacts:', error);
        res.status(500).json({ error: 'Failed to fetch contacts' });
    }
};

export const addContact = async (req: Request, res: Response): Promise<any> => {
    const userId = req.user?.id;
    const userUsername = req.user?.username; // Получаем username авторизованного пользователя

    if (!userId || !userUsername) {
        return res.status(401).json({ error: 'User not authenticated or user data incomplete' });
    }

    const { contact_email } = req.body;
    console.log(`Adding contact for user: ${userId} (${userUsername}) with email: ${contact_email}`);

    if (!contact_email) {
        return res.status(400).json({ error: 'Contact email is required.' });
    }
    
    // Получаем email текущего пользователя, чтобы предотвратить добавление себя по email
    const currentUser = await knex('users').select('email').where('id', userId).first();
    if (currentUser && currentUser.email === contact_email) {
        return res.status(400).json({ error: 'Вы не можете добавить себя в контакты.' });
    }

    try {
        const contactUser = await knex('users')
            .select('id', 'username', 'email') // Выбираем нужные поля для payload события
            .where('email', contact_email)
            .first();

        if (!contactUser) {
            console.log(`Contact with email ${contact_email} not found`);
            return res.status(404).json({ error: 'Пользователь с таким email не найден.' });
        }

        const contact_id = contactUser.id;

        if (userId === contact_id) { // Двойная проверка, на случай если email не совпал выше
            console.log(`User ${userId} tried to add themselves as a contact.`);
            return res.status(400).json({ error: 'Вы не можете добавить себя в контакты.' });
        }

        let newContactAdded = false;
        await knex.transaction(async (trx) => {
            // Проверяем, существует ли уже контакт
            const existingContact = await trx('contacts')
                .where({ user_id: userId, contact_id: contact_id })
                .first();

            if (!existingContact) {
                await trx('contacts').insert({
                    user_id: userId,
                    contact_id: contact_id
                });
                // Триггер add_reverse_contact_trigger должен автоматически добавить обратную запись (contact_id -> userId)
                newContactAdded = true;
            }
        });

        if (newContactAdded) {
            const targetRoom = `user_${contact_id}`;
            // payload для сокета: информация о пользователе, который добавил в контакты
            const eventPayload = {
                id: userId, 
                username: userUsername, 
                email: currentUser?.email, // email пользователя, который добавил
                // Можно добавить avatarPath если нужно
            };
            socketService.emitToRoom(targetRoom, 'newContactAdded', eventPayload);
            
            // payload для ответа: информация о добавленном контакте
            const responsePayload = {
                id: contactUser.id,
                username: contactUser.username,
                email: contactUser.email,
                // avatarPath для добавленного контакта можно получить отдельным запросом или если он уже есть в contactUser
            };
            res.status(201).json({ message: 'Контакт успешно добавлен.', contact: responsePayload });
            console.log(`Contact ${contact_id} (${contactUser.username}) added successfully for user ${userId} (${userUsername}).`);
        } else {
            res.status(200).json({ message: 'Контакт уже существует.', contactId: contact_id });
            console.log(`Contact relationship between ${userId} and ${contact_id} already exists.`);
        }

    } catch (error: any) {
        console.error('Error adding contact:', error);
        // Ошибки транзакции обрабатываются автоматически (rollback)
        if (error.code === '23503') { // Foreign key violation (если триггер или что-то пошло не так)
            return res.status(404).json({ error: 'Не удалось добавить контакт: пользователь-цель не найден.' });
        } else if (error.message.includes('Вы не можете добавить себя в контакты')) { // Кастомная ошибка
            return res.status(400).json({error: error.message });
        }
        res.status(500).json({ error: 'Не удалось добавить контакт' });
    }
};

export const deleteContact = async (req: Request, res: Response): Promise<any> => {
    const userId = req.user?.id;
    if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
    }

    const { contactId } = req.params;
    console.log(`Attempting to delete contact relationship between user ${userId} and contact ${contactId}`);

    if (!contactId) {
        return res.status(400).json({ error: 'Contact ID is required in URL parameters.' });
    }
    if (userId === contactId) {
        return res.status(400).json({ error: 'Нельзя удалить себя из контактов таким способом.' });
    }

    try {
        let relationshipsDeleted = 0;
        await knex.transaction(async (trx) => {
            // Удаляем A -> B
            const deleted1 = await trx('contacts')
                .where({ user_id: userId, contact_id: contactId })
                .del();
            // Удаляем B -> A (триггер на удаление обратной связи не предусмотрен, удаляем вручную)
            const deleted2 = await trx('contacts')
                .where({ user_id: contactId, contact_id: userId })
                .del();
            relationshipsDeleted = deleted1 + deleted2;
        });

        if (relationshipsDeleted > 0) {
            console.log(`Contact relationship between ${userId} and ${contactId} deleted successfully.`);

            const eventPayloadUser = { contactId: contactId }; 
            const userRoom = `user_${userId}`;
            socketService.emitToRoom(userRoom, 'contactRemoved', eventPayloadUser);

            const eventPayloadContact = { contactId: userId }; 
            const contactRoom = `user_${contactId}`;
            socketService.emitToRoom(contactRoom, 'contactRemoved', eventPayloadContact);

            res.status(200).json({ message: 'Контакт успешно удален.' });
        } else {
            console.log(`Contact relationship between ${userId} and ${contactId} not found.`);
            return res.status(404).json({ error: 'Контакт не найден.' });
        }

    } catch (error: any) {
        console.error('Error deleting contact:', error);
        if (error.code === '22P02') { 
            res.status(400).json({ error: 'Неверный формат ID контакта.' });
        } else {
            res.status(500).json({ error: 'Не удалось удалить контакт.' });
        }
    }
};
