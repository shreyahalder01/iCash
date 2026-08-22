import { Client, Account, Databases } from 'appwrite';

const client = new Client()
  .setEndpoint('https://sfo.cloud.appwrite.io/v1')
  .setProject('6a89af3a00114ef8b001');

const account = new Account(client);
const databases = new Databases(client);

export { client, account, databases };
