import { scrypt, randomBytes, timingSafeEqual } from 'crypto';


const SALT_LENGTH = 32;
const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };


export async function hashPassword(password: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const salt = randomBytes(SALT_LENGTH);
        scrypt(password, salt, KEY_LENGTH, SCRYPT_PARAMS, (err, derivedKey) => {
            if (err) reject(err);
            resolve(`scrypt:${salt.toString('hex')}:${derivedKey.toString('hex')}`);
        });
    });
}


export async function verifyPassword(password: string, hash: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const [algo, saltHex, keyHex] = hash.split(':');
        if (algo !== 'scrypt') {
            resolve(false);
            return;
        }
        const salt = Buffer.from(saltHex, 'hex');
        const storedKey = Buffer.from(keyHex, 'hex');
        scrypt(password, salt, KEY_LENGTH, SCRYPT_PARAMS, (err, derivedKey) => {
            if (err) reject(err);
            resolve(timingSafeEqual(storedKey, derivedKey));
        });
    });
}