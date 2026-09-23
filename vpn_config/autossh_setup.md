# Guía de Instalación y Configuración de Autossh en Raspberry Pi

Este documento reemplaza la configuración de `ssh-tunnel` con `autossh`, que es más robusto y autoreconecta si el túnel se rompe.

---

## 1. Instalar Autossh en la Raspberry Pi

Ejecuta en la terminal de la Pi:

```bash
# Actualizar e instalar autossh
sudo apt-get update
sudo apt-get install -y autossh

# Verificar instalación
which autossh
autossh -V
```

---

## 2. Eliminar la configuración actual de ssh-tunnel

```bash
pm2 stop ssh-tunnel
pm2 delete ssh-tunnel
pm2 save
```

---

## 3. Iniciar el túnel con Autossh

```bash
pm2 start "autossh -M 0 -N -R 127.0.0.1:3007:localhost:3007 root@67.205.176.223 -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -o TCPKeepAlive=yes" --name ssh-tunnel

pm2 save
```

### Explicación de parámetros:
- **`-M 0`**: Desactiva el modo de monitoreo de puertos (usamos solo keep-alive).
- **`-N`**: No ejecuta comandos, solo túnel.
- **`-R 127.0.0.1:3007:localhost:3007`**: Túnel reverso al puerto 3007.
- **`-o ServerAliveInterval=60`**: Envía keep-alive cada 60s.
- **`-o ServerAliveCountMax=3`**: Termina si fallan 3 keep-alive.
- **`-o ExitOnForwardFailure=yes`**: Sale si falla el reenvío de puertos (permite reinicio).
- **`-o TCPKeepAlive=yes`**: Habilita keep-alive de capa TCP.

---

## 4. Verificar estado

```bash
# Ver estado del túnel
pm2 status

# Ver logs en tiempo real
pm2 logs ssh-tunnel --lines 50

# Verificar que el túnel esté activo en el Droplet
ssh root@67.205.176.223 "ss -tulpn | grep :3007"
```

---

## 5. Diagnóstico si el túnel se rompe

### En la Raspberry Pi:
```bash
# Ver logs recientes de autossh
pm2 logs ssh-tunnel --lines 30

# Probar túnel manual en primer plano para ver errores
autossh -M 0 -N -R 127.0.0.1:3007:localhost:3007 root@67.205.176.223 -o ServerAliveInterval=60 -v
```

### En el Droplet:
```bash
# Verificar que el túnel esté escuchando
ss -tulpn | grep :3007

# Probar respuesta del bot
curl -I http://127.0.0.1:3007/status
```

---

## 6. (Opcional) Configurar reinicio automático tras reboot

Si la Raspberry Pi se apaga y vuelve a encender:

```bash
# Ya está configurado por pm2 save
pm2 startup
```
