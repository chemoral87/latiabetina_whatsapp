# Latiabetina WhatsApp Service

This is a Node.js service that uses `whatsapp-web.js` to send automated WhatsApp messages.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run the service:
   ```bash
   npm start
   ```

3. On first run, scan the QR code displayed in the console with WhatsApp Web.

The service will listen on `http://localhost:3002`.

## API

### POST /api/send-message

Send a WhatsApp message.

**Request Body:**
```json
{
  "phone": "521XXXXXXXXXX",
  "message": "Hello from Latiabetina!"
}
```

**Response:**
```json
{
  "id": "3EB0XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX@c.us_3EB0XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
}
```

## Integration

This service is called from the Laravel API after creating a new church member.

Configure in Laravel `.env`:
```
WHATSAPP_BOT_URL=http://127.0.0.1:3002
```