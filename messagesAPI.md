# Messages API

This document outlines the API endpoints for managing messages within dialogs and groups.
All endpoints require authentication and the `Authorization: Bearer <token>` header.
The base path for these routes is `/api/messages`.

## Common Message Object Structure

Many endpoints will return a message object or an array of message objects. A full message object generally includes:

```json
{
    "id": "uuid",
    "dialog_id": "uuid | null",
    "group_id": "uuid | null",
    "sender_id": "uuid",
    "sender_username": "string",
    "senderAvatarPath": "string | null",
    "content": "string | null",
    "created_at": "ISO8601Timestamp",
    "is_edited": "boolean",
    "replied_to_message_id": "uuid | null",
    "replied_to_sender_username": "string | null",
    "replied_to_content_preview": "string | null", // e.g., "Text..." or "Файл: image.jpg"
    "is_forwarded": "boolean",
    "forwarded_from_user_id": "uuid | null",
    "forwarded_from_username": "string | null",
    "original_message_id": "uuid | null", // If forwarded, the ID of the absolute original message
    "is_read_by_current_user": "boolean", // Specific to fetchAllMessages, indicates if the current user has read this message
    "is_unread": "boolean", // Specific to fetchAllMessages, true if !is_read_by_current_user && sender_id !== currentUser.id
    "read_by_users": [
        {
            "contact_id": "uuid",
            "username": "string",
            "email": "string",
            "read_at": "ISO8601Timestamp",
            "avatarPath": "string | null"
        }
    ],
    "files": [
        {
            "id": "uuid",
            "file_name": "string",
            "file_type": "string",
            "file_size": "integer", // in bytes
            "created_at": "ISO8601Timestamp",
            "download_url": "string" // e.g., "/messages/files/download_body/<file_id>"
        }
    ]
}
```

## Fetch All Messages

-   **URL:** `/fetch`
-   **Method:** `POST`
-   **Description:** Fetches messages for a given dialog or group, with pagination.
-   **Request Body:**
    ```json
    {
        "dialog_id": "uuid", // Required if group_id is not provided
        "group_id": "uuid"  // Required if dialog_id is not provided
    }
    ```
-   **Query Parameters:**
    -   `limit`: `integer` (optional, default: 50) - Number of messages to fetch.
    -   `offset`: `integer` (optional, default: 0) - Number of messages to skip.
-   **Success Response (200):** An array of [Common Message Objects](#common-message-object-structure).
-   **Error Responses:**
    -   `400 Bad Request`: "Необходимо указать dialog_id или group_id в теле запроса", "Укажите либо dialog_id, либо group_id, но не оба".
    -   `401 Unauthorized`: "Пользователь не авторизован".
    -   `403 Forbidden`: "Доступ запрещен: Вы не являетесь участником этого диалога/группы".
    -   `500 Internal Server Error`: "Не удалось получить сообщения".

## Send Message (Primarily via Socket)

While there isn't a direct REST endpoint just for sending a text message (this is handled by `handleSendMessage` socket event), the `/files/upload` endpoint creates a message.
-   **Socket Event for Sending:** `sendMessage` (client to server)
    -   Payload:
        ```json
        {
            "dialog_id": "uuid | null",
            "group_id": "uuid | null",
            "sender_id": "uuid", // Must match authenticated user
            "content": "string | null",
            "mentions": ["uuid"], // Optional
            "fileIds": ["uuid"], // Optional, IDs of pre-uploaded files if any (not typical flow with REST)
            "replied_to_message_id": "uuid | null" // Optional
        }
        ```
-   **Socket Event on Success:** `newMessage` (server to room) with the [Common Message Object](#common-message-object-structure).
-   **Socket Event on Failure:** `sendMessage_failed` (server to client) with error details.

## Edit Message (REST & Socket)

-   **URL:** `/`
-   **Method:** `PATCH`
-   **Description:** Edits the content of an existing message. Only the sender can edit their message.
-   **Request Body:**
    ```json
    {
        "messageId": "uuid",
        "content": "string", // New message content
        "dialog_id": "uuid", // or group_id, context of the message
        "group_id": "uuid"
    }
    ```
-   **Success Response (200):** The updated [Common Message Object](#common-message-object-structure).
-   **Socket Event Emitted by Server:** `messageUpdated` (or `messageEdited` via `handleEditMessage` socket handler) to the conversation room.
    -   Payload (example from `messageSocket.ts` for `messageEdited`):
        ```json
        {
            "message_id": "uuid",
            "dialog_id": "uuid | undefined",
            "group_id": "uuid | undefined",
            "sender_id": "uuid",
            "content": "string",
            "sender_username": "string",
            "avatarUrl": "string | null",
            "updated_at": "ISO8601Timestamp"
        }
        ```
    -   The REST controller emits `messageUpdated` with the full message object.
-   **Error Responses:**
    -   `400 Bad Request`: Missing fields, content empty, message not in specified conversation.
    -   `401 Unauthorized`: "Пользователь не аутентифицирован".
    -   `403 Forbidden`: "Вы не можете редактировать это сообщение".
    -   `404 Not Found`: "Сообщение не найдено".
    -   `500 Internal Server Error`: "Ошибка сервера при редактировании сообщения".

## Delete Message

-   **URL:** `/`
-   **Method:** `DELETE`
-   **Description:** Deletes a message. Only the sender can delete their message.
-   **Request Body:**
    ```json
    {
        "messageId": "uuid",
        "dialog_id": "uuid", // or group_id, context of the message
        "group_id": "uuid"
    }
    ```
-   **Success Response (204):** No content.
-   **Socket Event Emitted by Server:** `messageDeleted` to the conversation room.
    -   Payload: `{"id": "uuid", "dialog_id": "uuid | null", "group_id": "uuid | null"}`
-   **Error Responses:**
    -   `400 Bad Request`: Missing fields, message not in specified conversation.
    -   `401 Unauthorized`: "Пользователь не аутентифицирован".
    -   `403 Forbidden`: "Вы не можете удалить это сообщение".
    -   `404 Not Found`: (Implicit, if deletion affects 0 rows after checks)
    -   `500 Internal Server Error`: "Ошибка сервера при удалении сообщения".

## Forward Messages

-   **URL:** `/forward`
-   **Method:** `POST`
-   **Description:** Forwards one or more messages to specified dialogs and/or groups.
-   **Request Body:**
    ```json
    {
        "message_ids": ["uuid"], // Array of original message IDs to forward
        "target_dialog_ids": ["uuid"], // Optional
        "target_group_ids": ["uuid"]  // Optional (at least one target must be specified)
    }
    ```
-   **Success Response (200):**
    ```json
    {
        "success": true,
        "forwarded_messages": {
            "<target_dialog_id_1>": ["<new_message_id_1>", "<new_message_id_2>"],
            "<target_group_id_1>": ["<new_message_id_3>"]
        }
    }
    ```
-   **Socket Event Emitted by Server:** `newMessage` for each newly created forwarded message to its respective target conversation room, containing the [Common Message Object](#common-message-object-structure) for the forwarded message.
-   **Error Responses:**
    -   `400 Bad Request`: Invalid input (e.g., empty message_ids, no targets).
    -   `401 Unauthorized`: "Пользователь не аутентифицирован или данные пользователя неполны".
    -   `403 Forbidden`: If user is not a participant of a target dialog/group.
    -   `500 Internal Server Error`: "Ошибка сервера при пересылке сообщений".

## Upload File and Create Message

-   **URL:** `/files/upload`
-   **Method:** `POST`
-   **Content-Type:** `multipart/form-data`
-   **Description:** Uploads a file and creates a new message with this file attached (and optional text content) in a specified dialog or group.
-   **Form Data Fields:**
    -   `file`: The file to upload.
    -   `dialog_id`: `uuid` (Required if group_id is not provided)
    -   `group_id`: `uuid` (Required if dialog_id is not provided)
    -   `content`: `string` (Optional text content for the message)
-   **Success Response (201):**
    ```json
    {
        "message": "Файл успешно загружен и сообщение создано",
        "fileId": "uuid", // ID of the entry in the 'files' table
        "messageId": "uuid", // ID of the created message
        "fileInfo": {
            "id": "uuid",
            "file_name": "string",
            "file_type": "string",
            "file_size": "integer",
            "created_at": "ISO8601Timestamp",
            "download_url": "string" // e.g., "messages/files/download_body/<fileId>"
        }
    }
    ```
-   **Socket Event Emitted by Server:** `newMessage` to the conversation room with the [Common Message Object](#common-message-object-structure) for the new message (including file details).
-   **Error Responses:**
    -   `400 Bad Request`: "Файл не был загружен", "Не указан ID диалога или группы", "Укажите либо dialog_id, либо group_id, но не оба", Multer errors (e.g., file too large).
    -   `401 Unauthorized`: "Пользователь не аутентифицирован".
    -   `403 Forbidden`: "Вы не являетесь участником этого диалога/группы".
    -   `500 Internal Server Error`: "Не удалось загрузить файл и создать сообщение".

## Download Message File

-   **URL:** `/files/download_body`
-   **Method:** `POST` (Uses POST to send `file_id` in the body, though semantically a GET operation for the resource itself)
-   **Description:** Downloads a file attached to a message. User must be a participant in the conversation where the file was sent.
-   **Request Body:**
    ```json
    {
        "file_id": "uuid"
    }
    ```
-   **Success Response (200):** The file stream. Headers `Content-Type` and `Content-Disposition` (with `attachment; filename="..."`) will be set.
-   **Error Responses:**
    -   `400 Bad Request`: "Необходимо передать file_id в теле запроса", "Неверный формат ID файла".
    -   `401 Unauthorized`: "Пользователь не аутентифицирован".
    -   `403 Forbidden`: If user is not a participant of the conversation containing the file.
    -   `404 Not Found`: "Файл не найден", "Запрошенный файл не найден на диске".
    -   `500 Internal Server Error`: "Не удалось скачать файл", "Не удалось отправить файл".

## Get Message File Info

-   **URL:** `/files/info`
-   **Method:** `POST` (Uses POST to send `file_id` in the body)
-   **Description:** Retrieves metadata for a specific file attached to a message. User must be a participant in the conversation.
-   **Request Body:**
    ```json
    {
        "file_id": "uuid"
    }
    ```
-   **Success Response (200):**
    ```json
    {
        "id": "uuid",
        "file_name": "string",
        "file_type": "string",
        "file_size": "integer",
        "created_at": "ISO8601Timestamp",
        "download_url": "string" // e.g., "/messages/files/download_body/<file_id>"
    }
    ```
-   **Error Responses:**
    -   `400 Bad Request`: "Необходимо передать file_id в теле запроса", "Неверный формат ID файла".
    -   `401 Unauthorized`: "Пользователь не аутентифицирован".
    -   `403 Forbidden`: "Доступ к информации о файле запрещен: Вы не участник этого диалога/группы".
    -   `404 Not Found`: "Файл не найден или не привязан к сообщению".
    -   `500 Internal Server Error`: "Не удалось получить информацию о файле".

## Other Socket-Handled Message Events (Not direct REST APIs)

-   **Mark Messages as Read:**
    -   Socket Event: `markMessagesAsRead` (client to server)
        -   Payload: `{ dialog_id?: "uuid", group_id?: "uuid", message_ids: ["uuid"] }`
    -   Socket Event on Success: `messagesRead` (server to room)
        -   Payload: `{ dialog_id?: "uuid", group_id?: "uuid", user_id: "uuid", avatarUrl: "string|null", message_ids: ["uuid"], read_at: "ISO8601Timestamp" }`
-   **User Typing:**
    -   Socket Event: `start_typing` (client to server)
        -   Payload: `{ dialog_id?: "uuid", group_id?: "uuid", user_id: "uuid" }`
    -   Socket Event Emitted: `user_typing` (server to room, excluding sender)
        -   Payload: `{ dialog_id?: "uuid", group_id?: "uuid", user_id: "uuid" }`
-   **User Stopped Typing:**
    -   Socket Event: `stop_typing` (client to server)
        -   Payload: `{ dialog_id?: "uuid", group_id?: "uuid", user_id: "uuid" }`
    -   Socket Event Emitted: `user_stopped_typing` (server to room, excluding sender)
        -   Payload: `{ dialog_id?: "uuid", group_id?: "uuid", user_id: "uuid" }`

</rewritten_file> 