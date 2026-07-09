# Reddit Account Management CRM - Backend API Documentation

This document describes the API interface exposed by the Hono Edge backend. All routes (excluding login) require authentication via JWT Bearer tokens.

---

## Authentication Flow

1. All endpoints under `/api/tasks/*` and `/api/admin/*` require a Bearer token in the `Authorization` header.
2. Log in using `POST /api/auth/login` to obtain the token.
3. Include the token in subsequent requests:
   ```http
   Authorization: Bearer <your_jwt_token_here>
   ```
4. Tokens expire in **7 days**.

---

## Endpoint Reference

### 1. Authentication

#### `POST /api/auth/login`
Authenticates a user and returns a session JWT.
* **Payload**:
  ```json
  {
    "email": "user@redditcrm.com",
    "password": "UserPass2026!"
  }
  ```
* **Success Response (200 OK)**:
  ```json
  {
    "token": "eyJhbGciOiJIUzI1Ni...",
    "user": {
      "id": "8a329d47-6997-447a-9db1-cc72cb5e612a",
      "email": "user@redditcrm.com",
      "paypal": "user_paypal@paypal.com",
      "reddit": "reddit_username",
      "roles": ["basic"]
    }
  }
  ```
* **Error Response (401 Unauthorized)**:
  ```json
  { "error": "Invalid email or password" }
  ```

---

### 2. Basic User Dashboard APIs

#### `GET /api/tasks/available`
Fetches tasks currently available for booking, along with the user's active task (if any).
* **Headers**: `Authorization: Bearer <token>`
* **Success Response (200 OK)**:
  ```json
  {
    "available": [
      {
        "id": "e9641772-2bb8-410a-9d62-9e90956c3822",
        "subreddit": "reactjs",
        "post_url": "https://reddit.com/r/reactjs/comments/example",
        "client_request": "Leave a detailed review of the new Vite setup features.",
        "quota": 1,
        "price": "7.50",
        "deadline": null,
        "type_name": "Normal"
      }
    ],
    "active": null
  }
  ```

#### `POST /api/tasks/book`
Atomically books an available task. Decrements the task quota.
* **Headers**: `Authorization: Bearer <token>`
* **Payload**:
  ```json
  {
    "taskId": "e9641772-2bb8-410a-9d62-9e90956c3822"
  }
  ```
* **Success Response (200 OK)**:
  ```json
  {
    "success": true,
    "booking": {
      "id": "f51952a2-3f82-468e-ad11-54c30c80ee91",
      "user_id": "8a329d47-6997-447a-9db1-cc72cb5e612a",
      "task_id": "e9641772-2bb8-410a-9d62-9e90956c3822",
      "status_id": "incomplete",
      "reply_url": null,
      "note": null,
      "created_at": "2026-07-09T00:00:00.000Z",
      "updated_at": "2026-07-09T00:00:00.000Z"
    }
  }
  ```
* **Error Response (400 Bad Request)**:
  ```json
  {
    "error": "You can only perform one task at a time.",
    "code": "LIMIT_EXCEEDED"
  }
  ```
  *(Other error codes: `ALREADY_ATTEMPTED`, `NO_QUOTA`, `EXPIRED`, `NOT_FOUND`)*

#### `POST /api/tasks/submit`
Submits the Reddit reply URL for the active booked task, transitioning its status to `pending`.
* **Headers**: `Authorization: Bearer <token>`
* **Payload**:
  ```json
  {
    "taskId": "e9641772-2bb8-410a-9d62-9e90956c3822",
    "replyUrl": "https://reddit.com/r/reactjs/comments/example/reply/1234",
    "note": "Optional completion notes go here."
  }
  ```
* **Success Response (200 OK)**:
  ```json
  {
    "success": true,
    "booking": {
      "id": "f51952a2-3f82-468e-ad11-54c30c80ee91",
      "status_id": "pending",
      "reply_url": "https://reddit.com/r/reactjs/comments/example/reply/1234",
      "note": "Optional completion notes go here.",
      "updated_at": "2026-07-09T00:01:00.000Z"
    }
  }
  ```

#### `GET /api/tasks/earnings`
Compiles all finished task bookings and sums paid vs pending success balances.
* **Headers**: `Authorization: Bearer <token>`
* **Success Response (200 OK)**:
  ```json
  {
    "history": [
      {
        "booking_id": "f51952a2-3f82-468e-ad11-54c30c80ee91",
        "status_id": "success",
        "reply_url": "https://reddit.com/...",
        "note": "Approved. Great feedback.",
        "created_at": "2026-07-09T00:00:00Z",
        "updated_at": "2026-07-09T00:05:00Z",
        "task_id": "e9641772-2bb8-410a-9d62-9e90956c3822",
        "subreddit": "reactjs",
        "price": "7.50",
        "type_name": "Normal"
      }
    ],
    "paidBalance": 0,
    "pendingBalance": 7.50
  }
  ```

---

### 3. Admin Dashboard APIs
*(All admin APIs require JWT containing role `admin` or `choi`)*

#### `POST /api/admin/users`
Creates a basic user account and hashes the password securely.
* **Headers**: `Authorization: Bearer <admin_token>`
* **Payload**:
  ```json
  {
    "email": "newuser@redditcrm.com",
    "password": "SecurePassword123!",
    "paypal": "new_paypal@paypal.com",
    "reddit": "new_reddit_username"
  }
  ```
* **Success Response (200 OK)**:
  ```json
  {
    "success": true,
    "user": {
      "id": "9b122e92-3bc8-439d-b82b-10c22c8ee12a",
      "email": "newuser@redditcrm.com",
      "paypal": "new_paypal@paypal.com",
      "reddit": "new_reddit_username",
      "created_at": "2026-07-09T00:00:00Z"
    }
  }
  ```

#### `GET /api/admin/users`
Retrieves a list of all Basic users with payout summaries (PayPal email, pending, and paid balances).
* **Headers**: `Authorization: Bearer <admin_token>`
* **Success Response (200 OK)**:
  ```json
  {
    "users": [
      {
        "id": "9b122e92-3bc8-439d-b82b-10c22c8ee12a",
        "email": "newuser@redditcrm.com",
        "paypal": "new_paypal@paypal.com",
        "reddit": "new_reddit_username",
        "createdAt": "2026-07-09T00:00:00Z",
        "pendingBalance": 7.50,
        "paidBalance": 15.00
      }
    ]
  }
  ```

#### `POST /api/admin/tasks`
Creates a new coordinated task.
* **Headers**: `Authorization: Bearer <admin_token>`
* **Payload**:
  ```json
  {
    "subreddit": "reactjs",
    "postUrl": "https://reddit.com/r/reactjs/...",
    "clientRequest": "Upvote and leave a supportive comment about scaling static builds.",
    "quota": 5,
    "price": 5.00,
    "typeId": "normal",
    "assignedTo": null,
    "deadline": "2026-07-15T23:59:59Z"
  }
  ```

#### `GET /api/admin/tasks`
Lists all tasks and detailed booking status aggregates.
* **Headers**: `Authorization: Bearer <admin_token>`
* **Success Response (200 OK)**:
  ```json
  {
    "tasks": [
      {
        "id": "e9641772-2bb8-410a-9d62-9e90956c3822",
        "subreddit": "reactjs",
        "post_url": "...",
        "client_request": "...",
        "quota": 4,
        "price": "5.00",
        "deadline": "2026-07-15T23:59:59.000Z",
        "type_id": "normal",
        "type_name": "Normal",
        "assigned_to_email": null,
        "count_incomplete": 0,
        "count_pending": 1,
        "count_success": 0,
        "count_paid": 0,
        "count_failed": 0
      }
    ]
  }
  ```

#### `POST /api/admin/tasks/review`
Approves or rejects a user task submission.
* **Headers**: `Authorization: Bearer <admin_token>`
* **Payload**:
  ```json
  {
    "bookingId": "f51952a2-3f82-468e-ad11-54c30c80ee91",
    "statusId": "success",
    "note": "Approved. Excellent comment."
  }
  ```

#### `POST /api/admin/payouts`
Locks and transitions all user bookings with `success` status to `paid` status, resetting pending balances to 0.
* **Headers**: `Authorization: Bearer <admin_token>`
* **Payload**:
  ```json
  {
    "userId": "8a329d47-6997-447a-9db1-cc72cb5e612a"
  }
  ```
* **Success Response (200 OK)**:
  ```json
  {
    "success": true,
    "message": "Successfully marked 3 tasks as Paid.",
    "count": 3
  }
  ```

---

## Frontend Integration Wrapper Example

Here is a simple template showing how the React client can query this backend API:

```javascript
// src/services/api.js

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:8787';

function getAuthHeader() {
  const token = localStorage.getItem('crm_token');
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

export async function request(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...getAuthHeader(),
    ...options.headers,
  };

  const response = await fetch(url, { ...options, headers });
  
  if (response.status === 401) {
    localStorage.removeItem('crm_token');
    localStorage.removeItem('crm_user');
    window.location.href = '/';
    throw new Error('Session expired. Please log in again.');
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Network request failed');
  }

  return data;
}

export const authService = {
  login: async (email, password) => {
    const data = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    localStorage.setItem('crm_token', data.token);
    localStorage.setItem('crm_user', JSON.stringify(data.user));
    return data.user;
  },
  logout: () => {
    localStorage.removeItem('crm_token');
    localStorage.removeItem('crm_user');
    window.location.href = '/';
  }
};

export const taskService = {
  getAvailable: () => request('/api/tasks/available'),
  book: (taskId) => request('/api/tasks/book', {
    method: 'POST',
    body: JSON.stringify({ taskId }),
  }),
  submit: (taskId, replyUrl, note) => request('/api/tasks/submit', {
    method: 'POST',
    body: JSON.stringify({ taskId, replyUrl, note }),
  }),
  getEarnings: () => request('/api/tasks/earnings')
};
```
