This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Managing Windows servers

Bosun talks to Windows hosts over the same SSH transport it uses for Linux: it runs
PowerShell over the host's OpenSSH server, the same way
`Enter-PSSession -HostName <host> -SSHTransport` does. To add a Windows machine:

1. Install and enable OpenSSH Server on the host (Windows 10 1809+ / Server 2019+):

   ```powershell
   Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
   Start-Service sshd
   Set-Service -Name sshd -StartupType Automatic
   ```

2. Authorize the Bosun public key. For an administrative account the key must go in
   the administrators file, with the ACLs OpenSSH requires:

   ```powershell
   # append the Bosun public key to the file, then lock down its ACLs
   icacls.exe "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
   ```

3. Optionally make PowerShell the default SSH shell:

   ```powershell
   New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
     -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force
   ```

4. In Bosun, add the server and set **Platform** to **Windows** (Add Server or Edit
   Server). Use the same SSH key you configured above. "Test Connection" and
   "Detect OS" then work over PowerShell, and the terminal widget opens an interactive
   PowerShell session.

`docker_containers` and `os_update_check` are not supported on Windows in this version;
they render a placeholder instead of an error. `gpu_monitoring` needs `nvidia-smi` on the
host, and `ollama_status` needs Ollama listening on `localhost:11434`.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
