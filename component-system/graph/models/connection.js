import mongoose from 'mongoose';

export async function connect(uri, { retries = 5, baseDelayMs = 1000 } = {}) {
  let attempt = 0;
  // Disable buffering so failed connections fail fast instead of queueing forever
  mongoose.set('bufferCommands', false);

  while (true) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
      console.log(`🗄️  Mongo: connected to ${uri}`);
      return mongoose;
    } catch (err) {
      attempt += 1;
      if (attempt > retries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`🗄️  Mongo: connect attempt ${attempt} failed (${err.message}); retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export async function disconnect() {
  await mongoose.disconnect();
}

export { mongoose };
