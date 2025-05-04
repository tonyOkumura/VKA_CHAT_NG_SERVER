# Avatar API Documentation

This document describes the API endpoints for managing user and group avatars.

**User Avatar Base URL:** `/api/avatars`
**Group Avatar Base URL:** `/conversations`

---

## User Avatars (`/api/avatars`)

### Upload/Update User Avatar

Uploads a new avatar for the currently authenticated user. If an avatar already exists for the user, it will be replaced (both in the database and the filesystem).

*   **Method:** `POST`
*   **Path:** `/upload`
*   **Authentication:** Required (Bearer Token)
*   **Request Type:** `multipart/form-data`
*   **Request Body:**
    *   Field: `avatar` (Type: `File`, Description: Image file, max 5MB)
*   **Success Response (201 Created):** `{ "message": "Avatar uploaded successfully", "avatarUrl": "/uploads/avatars/avatar-..." }`
*   **Error Responses:** 400 (No file, Not image), 401 (Unauthorized), 500 (Server error)

### Get User Avatar URL

Retrieves the URL of the avatar for a specific user.

*   **Method:** `GET`
*   **Path:** `/:userId`
*   **Authentication:** Not Required
*   **URL Parameters:** `userId` (UUID String)
*   **Success Response (200 OK):** `{ "avatarUrl": "/uploads/avatars/avatar-..." }`
*   **Error Responses:** 400 (Missing userId), 404 (Not found), 500 (Server error)

### Get User Avatar Image (Stream)

Retrieves the actual image file bytes for a specific user avatar.

*   **Method:** `GET`
*   **Path:** `/stream/:userId`
*   **Authentication:** Not Required
*   **URL Parameters:** `userId` (UUID String)
*   **Success Response (200 OK):** Image file bytes with correct `Content-Type` header (e.g., `image/jpeg`).
*   **Error Responses:** 400 (Missing userId), 404 (Avatar not found), 500 (Server error)

### Delete User Avatar

Deletes the avatar for the currently authenticated user.

*   **Method:** `DELETE`
*   **Path:** `/delete`
*   **Authentication:** Required (Bearer Token)
*   **Request Body:** None
*   **Success Response (200 OK / 204 No Content):** `{ "message": "Avatar deleted successfully" }` (May include warning if file deletion failed)
*   **Error Responses:** 401 (Unauthorized), 404 (Not found), 500 (Server error)

---

## Group Avatars (`/conversations`)

### Upload/Update Group Avatar

Uploads or updates the avatar for a specific group conversation. Requires the user to be the group admin.

*   **Method:** `POST`
*   **Path:** `/:conversationId/avatar`
*   **Authentication:** Required (Bearer Token)
*   **Permissions:** Group Admin Only
*   **URL Parameters:** `conversationId` (UUID String)
*   **Request Type:** `multipart/form-data`
*   **Request Body:**
    *   Field: `avatar` (Type: `File`, Description: Image file, max 2MB)
*   **Success Response (200 OK):** `{ "message": "Group avatar updated successfully", "groupAvatarUrl": "/uploads/group_avatars/group-..." }`
*   **Error Responses:** 400 (No file, Not image, Not group), 401 (Unauthorized), 403 (Forbidden - not admin), 404 (Conversation not found), 500 (Server error)

### Delete Group Avatar

Deletes the avatar for a specific group conversation. Requires the user to be the group admin.

*   **Method:** `DELETE`
*   **Path:** `/:conversationId/avatar`
*   **Authentication:** Required (Bearer Token)
*   **Permissions:** Group Admin Only
*   **URL Parameters:** `conversationId` (UUID String)
*   **Request Body:** None
*   **Success Response (200 OK):** `{ "message": "Group avatar deleted successfully" }`
*   **Error Responses:** 400 (Not group), 401 (Unauthorized), 403 (Forbidden - not admin), 404 (Conversation or Avatar not found), 500 (Server error)

--- 