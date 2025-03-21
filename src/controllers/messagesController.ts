import { Request, Response } from 'express';
import pool from '../models/db';

export const fetchAllMessagesByConversationId = async (req: Request, res: Response): Promise<void> => {
    const { conversation_id } = req.params;

    console.log(`Fetching messages for conversation: ${conversation_id}`);

    try {
        const result = await pool.query(
            `
            SELECT m.id, m.content, m.sender_id, m.conversation_id, m.created_at
            FROM messages m
            WHERE m.conversation_id = $1
            ORDER BY m.created_at ASC
            `,
            [conversation_id]
        );

        console.log(`Messages fetched successfully for conversation: ${conversation_id}`);
        res.json(result.rows.reverse());
    } catch (err) {
        console.error(`Failed to fetch messages for conversation ${conversation_id} - ${(err as Error).message}`);
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
