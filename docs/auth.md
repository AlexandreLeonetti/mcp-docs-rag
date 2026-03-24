# Authentication

We use JWT-based authentication for the web app.

## Login
Users log in with email and password. On success, the backend returns an access token and a refresh token.

## Password reset
Password reset is handled through a signed reset link sent by email. Reset links expire after 30 minutes.

## API auth
Internal APIs between services should use service tokens, not user JWTs.
