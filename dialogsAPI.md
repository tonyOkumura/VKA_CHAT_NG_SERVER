# Dialogs API

This document outlines the API endpoints for managing user dialogs (one-on-one conversations).
All endpoints require authentication and the `Authorization: Bearer <token>` header.
The base path for these routes is `/api/dialogs`.

## Fetch All Dialogs for User

-   **URL:** `/`
-   **Method:** `GET`
-   **Description:** Retrieves a list of all dialogs for the authenticated user, along with last message, unread counts, and other metadata.
-   **Success Response (200):**
    ```json
    [
        {
            "dialog_id": "uuid",
            "conversation_name": "string", // Username of the other participant
            "is_group": false,
            "conversation_avatarPath": "string | null", // Avatar of the other participant
            "conversation_isOnline": "boolean", // Online status of the other participant
            "last_message": "string | null", // Content of the last message
            "last_message_time": "timestamp | null",
            "last_message_sender_id": "uuid | null",
            "last_message_sender_username": "string | null",
            "last_message_is_forwarded": "boolean | null",
            "last_message_forwarded_from": "string | null",
            "last_message_content_preview": "string | null", // Preview of the last message, includes forwarding info
            "unread_count": "integer",
            "is_muted": "boolean",
            "last_read_timestamp": "timestamp | null",
            "notification_settings": {"sound": true, "vibration": true}, // Example, structure from DB
            "conversation_created_at": "timestamp"
        }
    ]
    ```
-   **Error Responses:**
    -   `401 Unauthorized`: "Пользователь не авторизован"
    -   `500 Internal Server Error`: "Не удалось получить список диалогов"

## Create Dialog

-   **URL:** `/`
-   **Method:** `POST`
-   **Description:** Creates a new dialog with another user. If a dialog already exists, it returns the existing dialog ID.
-   **Request Body:**
    ```json
    {
        "contact_id": "uuid" // The ID of the user to start a dialog with
    }
    ```
-   **Success Response (201 - New Dialog Created):**
    ```json
    {
        "dialog_id": "uuid"
    }
    ```
    *Socket Event Emitted:* `newDialog` to both participants with full dialog details:
    ```json
    {
        "dialog_id": "uuid",
        "conversation_name": "string", // Other user's username
        "is_group": false,
        "participants": [
            { "user_id": "uuid", "username": "string", "avatarPath": "string | null", "is_online": "boolean" },
            { "user_id": "uuid", "username": "string", "avatarPath": "string | null", "is_online": "boolean" }
        ],
        "created_at": "timestamp"
    }
    ```
-   **Success Response (200 - Dialog Already Exists):**
    ```json
    {
        "dialog_id": "uuid",
        "message": "Диалог уже существует"
    }
    ```
-   **Error Responses:**
    -   `400 Bad Request`: "Contact ID обязателен" or "Нельзя создать диалог с самим собой"
    -   `401 Unauthorized`: "Пользователь не авторизован"
    -   `404 Not Found`: "Указанный пользователь не найден"
    -   `409 Conflict`: "Диалог уже существует" (though usually caught and returns 200)
    -   `500 Internal Server Error`: "Не удалось создать диалог"

## Mark Dialog Read/Unread

-   **URL:** `/read`
-   **Method:** `POST`
-   **Description:** Marks all messages in a dialog as read, or marks the dialog as unread for the authenticated user.
-   **Request Body:**
    ```json
    {
        "dialogId": "uuid",
        "mark_as_unread": "boolean" // true to mark as unread, false to mark as read
    }
    ```
-   **Success Response (200):**
    ```json
    {
        "message": "Диалог отмечен как непрочитанный" | "Диалог отмечен как прочитанный",
        "unread_count": "integer"
    }
    ```
    *Socket Event Emitted:* `dialogUpdated` to the requesting user:
    ```json
    {
        "dialog_id": "uuid",
        "unread_count": "integer",
        "is_muted": "boolean"
    }
    ```
-   **Error Responses:**
    -   `400 Bad Request`: "Dialog ID обязателен", "mark_as_unread должен быть boolean", "Неверный формат ID диалога"
    -   `401 Unauthorized`: "Пользователь не авторизован"
    -   `403 Forbidden`: "Вы не участник этого диалога"
    -   `500 Internal Server Error`: "Ошибка при обновлении статуса прочтения диалога"

## Mute/Unmute Dialog

-   **URL:** `/mute`
-   **Method:** `PATCH`
-   **Description:** Mutes or unmutes a dialog for the authenticated user.
-   **Request Body:**
    ```json
    {
        "dialogId": "uuid",
        "is_muted": "boolean" // true to mute, false to unmute
    }
    ```
-   **Success Response (200):**
    ```json
    {
        "message": "Диалог muted" | "Диалог unmuted",
        "is_muted": "boolean"
    }
    ```
    *Socket Event Emitted:* `dialogUpdated` to the requesting user (same payload as for Mark Read/Unread).
-   **Error Responses:**
    -   `400 Bad Request`: "Dialog ID обязателен", "is_muted должен быть boolean", "Неверный формат ID диалога"
    -   `401 Unauthorized`: "Пользователь не авторизован"
    -   `403 Forbidden`: "Вы не участник этого диалога"
    -   `404 Not Found`: "Диалог не найден"
    -   `500 Internal Server Error`: "Ошибка при изменении статуса mute диалога"

## Leave Dialog

-   **URL:** `/leave`
-   **Method:** `DELETE`
-   **Description:** Allows the authenticated user to leave (and effectively delete) a dialog. This action deletes the dialog for both participants.
-   **Request Body:**
    ```json
    {
        "dialogId": "uuid"
    }
    ```
-   **Success Response (200):**
    ```json
    {
        "message": "Диалог успешно удален"
    }
    ```
    *Socket Event Emitted:* `dialogRemoved` to both (former) participants:
    ```json
    {
        "dialogId": "uuid"
    }
    ```
-   **Error Responses:**
    -   `400 Bad Request`: "Dialog ID обязателен", "Неверный формат ID диалога"
    -   `401 Unauthorized`: "Пользователь не авторизован"
    -   `403 Forbidden`: "Вы не участник этого диалога"
    -   `500 Internal Server Error`: "Ошибка при удалении диалога" 