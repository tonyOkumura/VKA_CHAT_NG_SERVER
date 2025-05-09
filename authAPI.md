# Authentication API

This document outlines the API endpoints for user authentication.

## Register User

-   **URL:** `/api/auth/register`
-   **Method:** `POST`
-   **Description:** Registers a new user.
-   **Request Body:**
    ```json
    {
        "username": "string",
        "email": "string",
        "password": "string"
    }
    ```
-   **Success Response (201):**
    ```json
    {
        "message": "User registered successfully",
        "user": {
            "id": "uuid",
            "username": "string",
            "email": "string",
            "is_online": "boolean",
            "created_at": "timestamp",
            "updated_at": "timestamp"
        }
    }
    ```
-   **Error Responses:**
    -   `409 Conflict`: "User with this email already exists" or "User with this username already exists" or "Username or email already exists"
    -   `500 Internal Server Error`: "Failed to register user"

## Login User

-   **URL:** `/api/auth/login`
-   **Method:** `POST`
-   **Description:** Logs in an existing user.
-   **Request Body:**
    ```json
    {
        "email": "string",
        "password": "string"
    }
    ```
-   **Success Response (200):**
    ```json
    {
        "message": "User logged in successfully",
        "token": "string (jwt)",
        "user": {
            "id": "uuid",
            "username": "string",
            "email": "string",
            "is_online": true,
            "created_at": "timestamp",
            "updated_at": "timestamp",
            "first_name": "string | null",
            "last_name": "string | null",
            "birth_date": "date | null",
            "avatar_path": "string | null"
        }
    }
    ```
-   **Error Responses:**
    -   `400 Bad Request`: "Invalid credentials"
    -   `404 Not Found`: "User not found"
    -   `500 Internal Server Error`: "Internal server error"

## Logout User

-   **URL:** `/api/auth/logout`
-   **Method:** `POST`
-   **Description:** Logs out the currently authenticated user.
-   **Headers:**
    -   `Authorization`: `Bearer <token>`
-   **Success Response (200):**
    ```json
    {
        "message": "User logged out successfully"
    }
    ```
-   **Error Responses:**
    -   `401 Unauthorized`: If token is invalid or expired (from authMiddleware)
    -   `403 Forbidden`: "No token provided" (from authMiddleware)
    -   `404 Not Found`: "User not found"
    -   `500 Internal Server Error`: "Failed to logout"

## Reset Password

-   **URL:** `/api/auth/password/reset`
-   **Method:** `PUT`
-   **Description:** Resets the user's password using a reset token.
-   **Request Body:**
    ```json
    {
        "token": "string",
        "newPassword": "string"
    }
    ```
-   **Success Response (200):**
    ```json
    {
        "message": "Password reset successfully"
    }
    ```
-   **Error Responses:**
    -   `401 Unauthorized`: "Invalid or expired reset token"
    -   `500 Internal Server Error`: "Failed to reset password"

## Check Authentication

-   **URL:** `/api/auth/auth/check`
-   **Method:** `GET`
-   **Description:** Checks if the current user is authenticated and returns user details.
-   **Headers:**
    -   `Authorization`: `Bearer <token>`
-   **Success Response (200):**
    ```json
    {
        "message": "Authentication successful",
        "user": {
            "id": "uuid",
            "username": "string",
            "email": "string",
            "is_online": "boolean",
            "created_at": "timestamp",
            "updated_at": "timestamp"
        }
    }
    ```
-   **Error Responses:**
    -   `401 Unauthorized`: If token is invalid or expired (from authMiddleware)
    -   `403 Forbidden`: "No token provided" (from authMiddleware)
    -   `404 Not Found`: "User not found"
    -   `500 Internal Server Error`: "Failed to verify authentication"

## Delete Account

-   **URL:** `/api/auth/account`
-   **Method:** `DELETE`
-   **Description:** Deletes the account of the currently authenticated user.
-   **Headers:**
    -   `Authorization`: `Bearer <token>`
-   **Success Response (200):**
    ```json
    {
        "message": "Account deleted successfully"
    }
    ```
-   **Error Responses:**
    -   `401 Unauthorized`: If token is invalid or expired (from authMiddleware)
    -   `403 Forbidden`: "No token provided" (from authMiddleware)
    -   `404 Not Found`: "User not found"
    -   `500 Internal Server Error`: "Failed to delete account" 