import { Request, Response } from 'express';
import pool from '../models/db';

export const fetchAllMessagesByConversationId = async (req: Request, res: Response): Promise<void> => {
    const { conversationId } = req.params;

    console.log(`Fetching messages for conversation: ${conversationId}`);

    try {
        const result = await pool.query(
            `
            SELECT m.id, m.content, m.sender_id, m.conversation_id, m.created_at
            FROM messages m
            WHERE m.conversation_id = $1
            ORDER BY m.created_at ASC
            `,
            [conversationId]
        );

        console.log(`Messages fetched successfully for conversation: ${conversationId}`);
        res.json(result.rows);
    } catch (err) {
        console.error(`Failed to fetch messages for conversation ${conversationId} - ${(err as Error).message}`);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
};

export const saveMessage = async (conversationId: string, senderId: string, content: string) => {
    console.log(`Saving message for conversation: ${conversationId}, sender: ${senderId}`);

    try {
        const result = await pool.query(
            `
            INSERT INTO messages (conversation_id, sender_id, content)
            VALUES ($1, $2, $3)
            RETURNING *
            `,
            [conversationId, senderId, content]
        );

        console.log(`Message saved successfully for conversation: ${conversationId}`);
        return result.rows[0];
    } catch (err) {
        console.error(`Failed to save message - ${(err as Error).message}`);
        throw new Error('Failed to save message');
    }
};
