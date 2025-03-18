import { Router } from "express";
import { addContact, fetchContacts } from "../controllers/contactsController";
import { verifyToken } from "../middlewares/authMiddleware";

const router = Router();

router.get('/', verifyToken, fetchContacts);
router.post('/', verifyToken, addContact);

export default router;