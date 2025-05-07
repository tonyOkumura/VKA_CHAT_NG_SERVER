import { Request, Response } from 'express';
import pool from '../models/db';
import * as socketService from '../services/socketService'; // Импортируем сервис

export const fetchContacts = async (req: Request, res: Response): Promise<any> => {
    let userId = null;
    if (req.user) {
        userId = req.user.id;
    } else {
        return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log(`Fetching contacts for user: ${userId}`);

    try {
        const result = await pool.query(
            `
            SELECT 
                u.id, 
                u.username, 
                u.email, 
                u.is_online,
                ua.file_path AS "avatarPath" -- Get relative path
            FROM contacts c
            JOIN users u ON u.id = c.contact_id
            LEFT JOIN user_avatars ua ON u.id = ua.user_id
            WHERE c.user_id = $1
            ORDER BY u.username ASC
            `,
            [userId]
        );

        console.log(`Contacts fetched successfully for user: ${userId}`);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching contacts:', error);
        res.status(500).json({ error: 'Failed to fetch contacts' });
    }
};

export const addContact = async (req: Request, res: Response): Promise<any> => {
    let userId = null;
    let userDetails = null;
    if (req.user) {
        userId = req.user.id;
        // Fetch adder's details for the event payload
        try {
             const userResult = await pool.query('SELECT id, username, email FROM users WHERE id = $1', [userId]);
             if (userResult.rows.length > 0) {
                 userDetails = userResult.rows[0];
             } else {
                  console.error(`Authenticated user ${userId} not found in DB.`);
                  return res.status(401).json({ error: 'Authenticated user not found.' });
             }
        } catch (dbError) {
             console.error(`Error fetching user details for ${userId}:`, dbError);
             return res.status(500).json({ error: 'Database error fetching user details.' });
        }
    } else {
        return res.status(401).json({ error: 'User not authenticated' });
    }

    const { contact_email } = req.body;

    console.log(`Adding contact for user: ${userId} with email: ${contact_email}`);

    if (!contact_email) {
        return res.status(400).json({ error: 'Contact email is required.' });
    }

    try {
        // Find the user to add by email
        const contactResult = await pool.query(
            `SELECT id FROM users WHERE email = $1`,
            [contact_email]
        );

        if (contactResult.rowCount === 0) {
            console.log(`Contact with email ${contact_email} not found`);
            return res.status(404).json({ error: 'Пользователь с таким email не найден.' });
        }

        const contact_id = contactResult.rows[0].id;

        // Prevent adding self as contact
        if (userId === contact_id) {
            console.log(`User ${userId} tried to add themselves as a contact.`);
            return res.status(400).json({ error: 'Вы не можете добавить себя в контакты.' });
        }

        // Use transaction to ensure both contact entries are added (or none)
        await pool.query('BEGIN');

        // Insert the contact relationship (A -> B)
        // The trigger add_reverse_contact_trigger should handle (B -> A)
        const insertResult = await pool.query(
            `
            INSERT INTO contacts (user_id, contact_id) 
            VALUES ($1, $2)
            ON CONFLICT (user_id, contact_id) DO NOTHING
            RETURNING *
            `,
            [userId, contact_id]
        );

        await pool.query('COMMIT');

        // Emit event only if a new contact was actually added
        // and the trigger successfully added the reverse contact
        if (insertResult.rowCount && insertResult.rowCount > 0) {
            // Send event to the added contact's personal room
            const targetRoom = `user_${contact_id}`;
            const eventPayload = {
                id: userDetails.id,
                username: userDetails.username,
                email: userDetails.email,
                // Add other fields if needed according to ContactModel
            };
            // console.log(`[Socket Emit] Event: newContactAdded | Target: Room ${targetRoom}`); // Лог внутри сервиса
            // io.to(targetRoom).emit('newContactAdded', eventPayload);
            socketService.emitToRoom(targetRoom, 'newContactAdded', eventPayload);
            // console.log(`Event newContactAdded emitted to room ${targetRoom} for adder ${userId}`);

             res.status(201).json({ message: 'Контакт успешно добавлен.', contactId: contact_id });
             console.log(`Contact ${contact_id} added successfully for user ${userId}.`);
        } else {
            // Contact relationship already existed
            res.status(200).json({ message: 'Контакт уже существует.', contactId: contact_id });
             console.log(`Contact relationship between ${userId} and ${contact_id} already exists.`);
        }

    } catch (error: any) {
        await pool.query('ROLLBACK');
        console.error('Error adding contact:', error);
        if (error.code === '23503') { // Foreign key violation
             res.status(404).json({ error: 'Не удалось добавить контакт: пользователь не найден.' });
        } else {
            res.status(500).json({ error: 'Не удалось добавить контакт' });
        }
    }
};

export const deleteContact = async (req: Request, res: Response): Promise<any> => {
    let userId = null;
    if (req.user) {
        userId = req.user.id;
    } else {
        return res.status(401).json({ error: 'User not authenticated' });
    }

    // Expect contact_id in params for RESTful approach
    const { contactId } = req.params;
    console.log(`Attempting to delete contact relationship between user ${userId} and contact ${contactId}`);

    if (!contactId) {
        return res.status(400).json({ error: 'Contact ID is required in URL parameters.' });
    }

    try {
        // Use transaction to ensure both sides of the contact relationship are deleted
        await pool.query('BEGIN');

        // Delete A -> B relationship
        const result1 = await pool.query(
            `DELETE FROM contacts WHERE user_id = $1 AND contact_id = $2 RETURNING *`,
            [userId, contactId]
        );

        // Delete B -> A relationship
        const result2 = await pool.query(
            `DELETE FROM contacts WHERE user_id = $1 AND contact_id = $2 RETURNING *`,
            [contactId, userId]
        );

        await pool.query('COMMIT');

        // Check if at least one relationship was deleted
        if ((result1.rowCount && result1.rowCount > 0) || (result2.rowCount && result2.rowCount > 0)) {
            console.log(`Contact relationship between ${userId} and ${contactId} deleted successfully.`);

            // Emit event to both users' personal rooms
            const eventPayload = { contactId: contactId }; // ID of the user being removed from contact list
            const userRoom = `user_${userId}`;
            const contactRoom = `user_${contactId}`;

            // console.log(`[Socket Emit] Event: contactRemoved | Target: Room ${userRoom}`); // Лог внутри сервиса
            // io.to(userRoom).emit('contactRemoved', eventPayload);
            socketService.emitToRoom(userRoom, 'contactRemoved', eventPayload);
            // console.log(`Event contactRemoved emitted to room ${userRoom}`);

            // Also notify the removed contact that they were removed by the user
            const reverseEventPayload = { contactId: userId }; // ID of the user who removed them
            // console.log(`[Socket Emit] Event: contactRemoved | Target: Room ${contactRoom}`); // Лог внутри сервиса
            // io.to(contactRoom).emit('contactRemoved', reverseEventPayload);
            socketService.emitToRoom(contactRoom, 'contactRemoved', reverseEventPayload);
            // console.log(`Event contactRemoved emitted to room ${contactRoom}`);

            res.status(200).json({ message: 'Контакт успешно удален.' });

        } else {
            console.log(`Contact relationship between ${userId} and ${contactId} not found.`);
            return res.status(404).json({ error: 'Контакт не найден.' });
        }

    } catch (error: any) {
        await pool.query('ROLLBACK');
        console.error('Error deleting contact:', error);
        if (error.code === '22P02') { // Invalid UUID format
            res.status(400).json({ error: 'Неверный формат ID контакта.' });
        } else {
            res.status(500).json({ error: 'Не удалось удалить контакт.' });
        }
    }
};
