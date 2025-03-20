import { Request, Response } from 'express';
import pool from '../models/db';

export const fetchContacts = async (req: Request, res: Response): Promise<any> => {
    let userId = null;
    if (req.user) {
        userId = req.user.id;
    }

    console.log(`Fetching contacts for user: ${userId}`);

    try {
        const result = await pool.query(
            `
            SELECT u.id AS contact_id, u.username, u.email
            FROM contacts c
            JOIN users u ON u.id = c.contact_id
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
    if (req.user) {
        userId = req.user.id;
    }

    const { contact_email } = req.body;

    console.log(`Adding contact for user: ${userId} with email: ${contact_email}`);

    try {
        const contactExists = await pool.query(
            `SELECT id FROM users WHERE email = $1`,
            [contact_email]
        );

        if (contactExists.rowCount === 0) {
            console.log('Contact not found');
            return res.status(404).json({ error: 'Contact not found' });
        }

        const contactId = contactExists.rows[0].id;

        await pool.query(
            `
            INSERT INTO contacts (user_id, contact_id) 
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING;
            `,
            [userId, contactId]
        );

        console.log(`Contact added successfully for user: ${userId}`);
        res.status(201).json({ message: 'Contact added successfully' });
    } catch (error) {
        console.error('Error adding contact:', error);
        res.status(500).json({ error: 'Failed to add contact' });
    }
};

export const deleteContact = async (req: Request, res: Response): Promise<any> => {
    let userId = null;
    if (req.user) {
        userId = req.user.id;
    }

    const { contactId } = req.body;

    console.log(`Deleting contact for user: ${userId} with contactId: ${contactId}`);

    try {
        const result = await pool.query(
            `DELETE FROM contacts WHERE user_id = $1 AND contact_id = $2 RETURNING *`,
            [userId, contactId]
        );

        if (result.rowCount === 0) {
            console.log('Contact not found');
            return res.status(404).json({ error: 'Contact not found' });
        }

        console.log(`Contact deleted successfully for user: ${userId}`);
        res.status(200).json({ message: 'Contact deleted successfully' });
    } catch (error) {
        console.error('Error deleting contact:', error);
        res.status(500).json({ error: 'Failed to delete contact' });
    }
};
