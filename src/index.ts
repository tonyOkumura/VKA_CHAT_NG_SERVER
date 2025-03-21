import express, { Request, Response } from 'express';
import { json } from 'body-parser';
import authRoutes from './routes/authRoutes';
import conversationsRoutes from './routes/conversationsRoutes';
import messagesRoutes from './routes/messagesRoutes';
import http from 'http';
import { Server } from 'socket.io';
import { saveMessage } from './controllers/messagesController'; // Import saveMessage
import contactsRoutes from './routes/contactsRoutes';

const app = express();
const server = http.createServer(app);
app.use(json());
const io = new Server(server, {
    cors: {
        origin: '*',
    },
});

app.use('/auth', authRoutes);
app.use('/conversations', conversationsRoutes);
app.use('/messages', messagesRoutes);
app.use('/contacts', contactsRoutes);

app.get('/', (req: Request, res: Response) => {
    console.log("test");
    res.send("yes it works");
});

io.on('connection', (socket) => {
    console.log('A user connected: ', socket.id);

    socket.on('joinConversation', (conversationId) => {
        socket.join(conversationId);
        console.log('User joined conversation: ' + conversationId);
    });
    
    socket.on('sendMessage', async (message) => {
        const { conversation_id, sender_id, content } = message;

        try {
            const savedMessage = await saveMessage(conversation_id, sender_id, content);
            console.log('sendMessage: ');
            console.log(savedMessage);
            io.to(conversation_id).emit('newMessage', savedMessage);
        } catch (err) {
            console.error('Failed to save message:', err);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected: ', socket.id);
    });
});

const PORT = process.env.PORT || 6000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});