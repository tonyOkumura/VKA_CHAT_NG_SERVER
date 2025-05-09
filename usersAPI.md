# Users API

This document outlines the API endpoints for user-related operations, such as fetching user lists and managing avatars.
The base path for these routes is `/api/users`.

## Common User Object Structure (for listings)

```json
{
    "user_id": "uuid",
    "username": "string",
    "email": "string",
    "is_online": "boolean",
    "avatarPath": "string | null", // Relative path or identifier for the avatar
    "created_at": "ISO8601Timestamp | null",
    "updated_at": "ISO8601Timestamp | null"
}
```
*Note: The `avatarPath` can be used to construct the full URL to stream the avatar, typically `/api/users/{user_id}/avatar`.*

---

## Get All Users

-   **URL:** `/all`
-   **Method:** `GET`
-   **Requires Authentication:** Yes (`Authorization: Bearer <token>`)
-   **Description:** Retrieves a list of all registered users.
-   **Success Response (200):** An array of [Common User Objects](#common-user-object-structure-for-listings).
    ```json
    [
        {
            "user_id": "uuid",
            "username": "string",
            "email": "string",
            "is_online": "boolean",
            "avatarPath": "string | null",
            "created_at": "ISO8601Timestamp | null",
            "updated_at": "ISO8601Timestamp | null"
        }
        // ... more users
    ]
    ```
-   **Error Responses:**
    -   `401 Unauthorized`: (Implicit from `authMiddleware` if token is missing or invalid)
    -   `500 Internal Server Error`: "Не удалось получить список пользователей"

---

## Upload User Avatar

-   **URL:** `/:userId/avatar`
-   **Method:** `POST`
-   **Content-Type:** `multipart/form-data`
-   **Requires Authentication:** Yes (`Authorization: Bearer <token>`)
-   **Description:** Uploads or replaces an avatar for the specified user. The authenticated user can only upload an avatar for themselves (i.e., `userId` in path must match authenticated user's ID).
-   **URL Parameters:**
    -   `userId`: `uuid` - The ID of the user whose avatar is being uploaded.
-   **Form Data Fields:**
    -   `avatar`: The image file to upload.
-   **Success Response (201):**
    ```json
    {
        "message": "Аватар успешно загружен",
        "filePath": "string", // Path where the avatar is stored internally (e.g., avatars/user_id/filename.ext)
        "fileName": "string", // Original name of the uploaded file
        "downloadUrl": "/users/{userId}/avatar" // Relative URL to stream the avatar
    }
    ```
    *Socket Event Emitted:* `userStatusChanged` (via general user update mechanisms if avatar change triggers it) to all clients, potentially with the updated `avatarUrl` or path.
-   **Error Responses:**
    -   `400 Bad Request`: "Файл не найден" (if no file is uploaded).
    -   `401 Unauthorized`: "Не авторизован".
    -   `403 Forbidden`: "Попытка загрузить аватар для другого пользователя".
    -   `500 Internal Server Error`: "Не удалось загрузить аватар" (e.g., file storage issue).

---

## Stream User Avatar

-   **URL:** `/:userId/avatar`
-   **Method:** `GET`
-   **Requires Authentication:** No (Typically public, but access can be restricted by `fileService` logic if needed for non-existent users).
-   **Description:** Streams the avatar image for the specified user.
-   **URL Parameters:**
    -   `userId`: `uuid` - The ID of the user whose avatar is requested.
-   **Success Response (200):** The image file stream. Headers `Content-Type` (e.g., `image/jpeg`, `image/png`) will be set based on the stored file.
-   **Error Responses:**
    -   `404 Not Found`: "Аватар не найден на сервере" (if the user has no avatar or file is missing).
    -   `500 Internal Server Error`: "Не удалось получить аватар".

---

## Delete User Avatar

-   **URL:** `/:userId/avatar`
-   **Method:** `DELETE`
-   **Requires Authentication:** Yes (`Authorization: Bearer <token>`)
-   **Description:** Deletes the avatar for the specified user. The authenticated user can only delete their own avatar.
-   **URL Parameters:**
    -   `userId`: `uuid` - The ID of the user whose avatar is being deleted.
-   **Success Response (200):**
    ```json
    {
        "message": "Аватар успешно удален"
    }
    ```
    *Socket Event Emitted:* `userStatusChanged` (via general user update mechanisms) to all clients, potentially with `avatarUrl` set to null or a default.
-   **Error Responses:**
    -   `401 Unauthorized`: "Не авторизован".
    -   `403 Forbidden`: "Попытка удалить аватар другого пользователя".
    -   `404 Not Found`: "Аватар не найден или уже удален".
    -   `500 Internal Server Error`: "Не удалось удалить аватар".

---

## Real-time User Updates via Sockets

While the above endpoints manage user data via REST, aspects like `is_online` status and notifications of avatar changes are typically handled in real-time via WebSockets.

-   **`userStatusChanged` Event:** Emitted to all clients when a user's online status changes (connect/disconnect, login/logout) or potentially when their avatar or other key profile information is updated. Payload usually includes:
    ```json
    {
        "userId": "uuid",
        "isOnline": "boolean",
        "username": "string",
        "avatarUrl": "string | null" // Could be the direct path or full URL
    }
    ```
-   **Notifications:** Custom notifications can be sent to specific users via the `notification` socket event (see `handleNotification` in `userSocket.ts`).

Refer to the socket event handlers (`authSocket.ts`, `userSocket.ts`) for detailed implementation of real-time updates. 