# Configuración del Túnel SSH Reverso (Raspberry Pi ⟷ DigitalOcean Droplet)

Guía completa de comandos y optimizaciones aplicadas en el servidor **DigitalOcean (Ubuntu)** y en la **Raspberry Pi (Local)** para mantener el túnel reverso del bot de WhatsApp estable, rápido y persistente.

---

## 🏗️ Arquitectura del Flujo

```text
[ Cliente Web / Laravel Backend ]
               │
               ▼
[ Nginx en Droplet (67.205.176.223) ]
  whatsapp.avivamientomonterrey.com ──► proxy_pass http://127.0.0.1:3007
                                                      │ (Túnel SSH Reverso)
                                                      ▼
[ Raspberry Pi en Casa ] ──────────────► [ Bot Node.js en localhost:3007 ]
```

---

## 1. Configuración y Optimización en DigitalOcean (Droplet)

Ejecutar en la consola del Droplet (`root@latiabetina-prod`):

### A. Resolver conflicto de sockets en SSH (Ubuntu 22.04 / 24.04)
Ubuntu activa `ssh.socket` por defecto, lo que causa cuelgues (`Connection refused` o desconexiones al negociar el banner SSH). Se deshabilita el socket para dejar el servicio nativo:

```bash
# Detener y deshabilitar socket conflictivo
systemctl stop ssh.socket
systemctl disable ssh.socket

# Asegurar que el servicio principal esté activo
systemctl restart ssh
```

### B. Optimizar `/etc/ssh/sshd_config`
Configurar las directivas necesarias para permitir el reenvío de puertos del túnel y eliminar demoras por resolución DNS inversa:

```bash
# Permitir reenvío de puertos para túneles remotos
echo "GatewayPorts yes" >> /etc/ssh/sshd_config

# Eliminar retrasos de conexión (desactivar reverse DNS y GSSAPI)
echo "UseDNS no" >> /etc/ssh/sshd_config
echo "GSSAPIAuthentication no" >> /etc/ssh/sshd_config

# Permitir login y autenticación por claves
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config

# Reiniciar SSH limpio
systemctl restart ssh
```

### C. Configuración de Firewall (UFW)
Asegurar que los puertos necesarios estén abiertos:

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow "Nginx Full"
ufw reload
```

### D. Configuración de Nginx para el subdominio
En `/etc/nginx/sites-available/whatsapp.avivamientomonterrey.com`:

```nginx
server {
    server_name whatsapp.avivamientomonterrey.com;

    location / {
        proxy_pass http://127.0.0.1:3007;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    listen 443 ssl; # Managed by Certbot
    listen 80;
}
```

---

## 2. Configuración en la Raspberry Pi (Casa)

Ejecutar en la terminal de la Pi (`pi@latiabetina-whatsapp`):

### A. Generar clave SSH y copiarla al Droplet (Sin contraseña)
```bash
# 1. Generar par de claves (si no existen)
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519

# 2. Copiar clave pública al Droplet
ssh-copy-id -i ~/.ssh/id_ed25519.pub root@67.205.176.223

# 3. Probar conexión directa
ssh root@67.205.176.223
# (Debe entrar directo sin pedir contraseña. Salir con: exit)
```

### B. Configurar el túnel reverso persistente con PM2
```bash
# 1. Eliminar configuración previa si existe
pm2 delete ssh-tunnel 2>/dev/null || true

# 2. Iniciar el túnel SSH con parámetros de keep-alive y recuperación automática
pm2 start "ssh -N -R 127.0.0.1:3007:localhost:3007 root@67.205.176.223 -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes" --name ssh-tunnel

# 3. Guardar el estado de PM2 para que inicie automáticamente al encender la Pi
pm2 save
```

---

## 3. Comandos de Diagnóstico y Verificación

### En el Droplet:
```bash
# Verificar que el puerto 22 está escuchando con sshd limpio
ss -tulpn | grep :22

# Verificar que el túnel esté escuchando en el puerto 3007
ss -tulpn | grep :3007

# Probar respuesta del bot a través del túnel local
curl -i http://127.0.0.1:3007/status?pw=admin123

# Si el puerto 3007 queda bloqueado por un proceso huérfano:
fuser -k 3007/tcp
```

### En la Raspberry Pi:
```bash
# Ver estado del túnel y del bot
pm2 status

# Ver logs en tiempo real del túnel
pm2 logs ssh-tunnel --lines 30

# Probar túnel manual en primer plano con depuración
ssh -v -N -R 127.0.0.1:3007:localhost:3007 root@67.205.176.223 -o ServerAliveInterval=60
```
