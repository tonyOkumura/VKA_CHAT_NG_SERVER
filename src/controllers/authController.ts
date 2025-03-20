import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../models/db';

const SALT_ROUNDS = 10;
const JWT_SECRET = 'worisecretkey';
//const JWT_SECRET = process.env.JWT_TOKEN || 'worisecretkey';

export const register = async (req: Request, res: Response) => {
    const { username, email, password } = req.body;
    console.log('Register request received:', { username, email, password });

    try {
        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
        console.log('Password hashed successfully');
        const result = await pool.query(
            'INSERT INTO users (username, email, password) VALUES ($1, $2, $3) RETURNING *',
            [username, email, hashedPassword]
        );
        const user = result.rows[0];
        console.log('User inserted into database:', user);

        res.status(201).json({ message: 'User registered successfully', user: user });
    } catch (error) {
        console.error('Error during registration:', error);
        res.status(500).json({ error: 'Failed to register user' });
    }
};

export const login = async (req: Request, res: Response): Promise<any> => {
    const { email, password } = req.body;
    console.log('Login request received:', { email, password });

    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];
        console.log('User fetched from database:', user);

        if (!user) {
            console.log('User not found');
            return res.status(404).json({ error: 'User not found' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            console.log('Invalid credentials');
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '10h' });
        console.log('Token generated:', token);
        res.json({ message: 'User logged in successfully', token: token });
    } catch (error) {
        console.error('Error during login:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};
