# Contacts API

This document outlines the API endpoints for managing user contacts.
All endpoints require authentication and the `Authorization: Bearer <token>` header.

## Fetch Contacts

-   **URL:** `/api/contacts/`
-   **Method:** `GET`
-   **Description:** Retrieves the list of contacts for the authenticated user.
-   **Success Response (200):**
    ```json
    [
        {
            "id": "uuid", // Contact's user ID
            "username": "string",
            "email": "string",
            "is_online": "boolean",
            "avatar_path": "string | null",
            "first_name": "string | null",
            "last_name": "string | null",
            "dialog_id": "uuid | null" // ID of the direct dialog with this contact
        }
    ]
    ```
-   **Error Responses:**
    -   `401 Unauthorized`: If token is invalid or expired.
    -   `403 Forbidden`: "No token provided".
    -   `500 Internal Server Error`: "Failed to fetch contacts".

## Add Contact

-   **URL:** `/api/contacts/`
-   **Method:** `POST`
-   **Description:** Adds a new contact for the authenticated user.
-   **Request Body:**
    ```json
    {
        "contactId": "uuid" // The ID of the user to add as a contact
    }
    ```
-   **Success Response (201):**
    ```json
    {
        "message": "Contact added successfully",
        "contact": {
            "id": "uuid", // Contact's user ID
            "username": "string",
            "email": "string",
            "is_online": "boolean",
            "avatar_path": "string | null",
            "first_name": "string | null",
            "last_name": "string | null"
        },
        "dialog": { // Information about the newly created or existing dialog
            "id": "uuid",
            "user1_id": "uuid",
            "user2_id": "uuid",
            "created_at": "timestamp"
        }
    }
    ```
-   **Error Responses:**
    -   `400 Bad Request`: "Contact ID is required".
    -   `401 Unauthorized`: If token is invalid or expired.
    -   `403 Forbidden`: "No token provided".
    -   `404 Not Found`: "User to add not found".
    -   `409 Conflict`: "Contact already exists".
    -   `500 Internal Server Error`: "Failed to add contact" or "Failed to create dialog".

## Delete Contact

-   **URL:** `/api/contacts/:contactId`
-   **Method:** `DELETE`
-   **Description:** Deletes a contact for the authenticated user.
-   **URL Parameters:**
    -   `contactId`: `uuid` - The ID of the contact to delete.
-   **Success Response (200):**
    ```json
    {
        "message": "Contact deleted successfully"
    }
    ```
-   **Error Responses:**
    -   `400 Bad Request`: "Invalid contact ID format".
    -   `401 Unauthorized`: If token is invalid or expired.
    -   `403 Forbidden`: "No token provided".
    -   `404 Not Found`: "Contact not found".
    -   `500 Internal Server Error`: "Failed to delete contact".

## Search Users

-   **URL:** `/api/contacts/search`
-   **Method:** `GET`
-   **Description:** Searches for users by username or email. This is typically used to find users to add as contacts.
-   **Query Parameters:**
    -   `query`: `string` - The search term (username or email).
-   **Success Response (200):**
    ```json
    [
        {
            "id": "uuid",
            "username": "string",
            "email": "string",
            "avatar_path": "string | null",
            "first_name": "string | null",
            "last_name": "string | null"
        }
    ]
    ```
-   **Error Responses:**
    -   `400 Bad Request`: "Search query is required".
    -   `401 Unauthorized`: If token is invalid or expired.
    -   `403 Forbidden`: "No token provided".
    -   `500 Internal Server Error`: "Failed to search users". 