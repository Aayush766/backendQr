import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

import {
  Restaurant,
  User,
  Table,
  Category,
  MenuItem,
  Order,
  Subscription,
  Notification,
  SubscriptionPayment,
  Coupon,
  Review,
  SupportTicket,
} from './models.js';

dotenv.config();

await mongoose.connect(
  process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/serveqr'
);

await Promise.all([
  Restaurant.deleteMany(),
  User.deleteMany(),
  Table.deleteMany(),
  Category.deleteMany(),
  MenuItem.deleteMany(),
  Order.deleteMany(),
  Subscription.deleteMany(),
  Notification.deleteMany(),
  SubscriptionPayment.deleteMany(),
  Coupon.deleteMany(),
  Review.deleteMany(),
  SupportTicket.deleteMany(),
]);

const expiryDate = new Date(Date.now() + 2592000000);

const r = await Restaurant.create({
  name: 'The Green Fork',
  slug: 'demo-green-fork',
  logo: 'https://images.unsplash.com/photo-1515003197210-e0cd71810b5f?w=200',
  phone: '+91 98765 43210',
  email: 'hello@greenfork.demo',
  address: '24 Garden Street, Bengaluru',
  googleReviewUrl:
    'https://www.google.com/search?q=The+Green+Fork+reviews',
  active: true,
  subscriptionStatus: 'active',
  expiryDate,
  languages: ['en', 'hi', 'kn'],
  billSettings: {
    upiId: 'greenfork@okhdfcbank',
    gstNumber: '29ABCDE1234F1Z5',
    taxPercent: 5,
    footerNote: 'Thank you for dining with us! Visit again.',
    showAddress: true,
  },
});

const password = await bcrypt.hash('password123', 10);

await User.create([
  {
    name: 'Aarav Mehta',
    email: 'admin@greenfork.demo',
    password,
    role: 'restaurant_admin',
    restaurant: r._id,
  },
  {
    name: 'ServeQR Owner',
    email: 'super@serveqr.demo',
    password,
    role: 'super_admin',
  },
]);

const tables = await Table.create(
  [1, 2, 3, 4, 5].map((n) => ({
    restaurant: r._id,
    name: `Table ${n}`,
    number: n,
    qrToken: `table-${n}`,
  }))
);

const cats = await Category.create(
  [
    'Starters',
    'Main Course',
    'Pizza',
    'Burger',
    'Drinks',
    'Desserts',
  ].map((name, sort) => ({
    restaurant: r._id,
    name,
    sort,
  }))
);

const food = [
  [
    'Crispy Corn',
    'A crunchy, tangy house favourite',
    199,
    0,
    'veg',
    '1547592180-85f173990554',
  ],
  [
    'Paneer Tikka',
    'Smoky paneer with mint chutney',
    289,
    0,
    'veg',
    '1567188040759-fb8a883dc6d8',
  ],
  [
    'Butter Paneer',
    'Creamy tomato gravy, soft paneer',
    349,
    1,
    'veg',
    '1515003197210-e0cd71810b5f',
  ],
  [
    'Chicken Biryani',
    'Fragrant basmati and tender chicken',
    399,
    1,
    'non-veg',
    '1563379926898-05f4575a45d8',
  ],
  [
    'Garden Margherita',
    'Tomato, basil, mozzarella',
    329,
    2,
    'veg',
    '1574071318508-1cdbab80d002',
  ],
  [
    'Smoky BBQ Chicken',
    'BBQ chicken, onions, mozzarella',
    449,
    2,
    'non-veg',
    '1513104890138-7c749659a591',
  ],
  [
    'Classic Veg Burger',
    'Crisp patty, lettuce and sauce',
    249,
    3,
    'veg',
    '1568901346375-23c9450c58cd',
  ],
  [
    'Fresh Lime Soda',
    'Sweet, salty, or classic',
    99,
    4,
    'veg',
    '1551024506-0bccd828d307',
  ],
  [
    'Chocolate Lava Cake',
    'Warm centre, vanilla scoop',
    179,
    5,
    'veg',
    '1606313564200-e75d5e30476c',
  ],
];

const tagsFor = (name) =>
  ({
    'Butter Paneer': ['Best Seller'],
    'Chicken Biryani': ['Best Seller', "Chef's Special"],
    'Chocolate Lava Cake': ['New'],
  }[name] || []);

const menu = await MenuItem.create(
  food.map((x) => ({
    restaurant: r._id,
    name: x[0],
    description: x[1],
    price: x[2],
    category: cats[x[3]]._id,
    type: x[4],
    available: true,
    tags: tagsFor(x[0]),
    image: `https://images.unsplash.com/photo-${x[5]}?auto=format&fit=crop&w=700&q=80`,

    // Feature demo: half/full portion pricing
    ...(x[0] === 'Paneer Tikka'
      ? {
          hasPortions: true,
          halfPrice: 169,
        }
      : {}),

    ...(x[0] === 'Chicken Biryani'
      ? {
          hasPortions: true,
          halfPrice: 229,
        }
      : {}),

    // Feature demo: multi-language menu
    ...(x[0] === 'Paneer Tikka'
      ? {
          translations: {
            hi: {
              name: 'पनीर टिक्का',
              description: 'पुदीने की चटनी के साथ स्मोकी पनीर',
            },
            kn: {
              name: 'ಪನೀರ್ ಟಿಕ್ಕಾ',
              description: 'ಪುದೀನ ಚಟ್ನಿಯೊಂದಿಗೆ ಹೊಗೆಯಾಡಿಸಿದ ಪನೀರ್',
            },
          },
        }
      : {}),

    ...(x[0] === 'Chicken Biryani'
      ? {
          translations: {
            hi: {
              name: 'चिकन बिरयानी',
              description: 'सुगंधित बासमती और नरम चिकन',
            },
            kn: {
              name: 'ಚಿಕನ್ ಬಿರಿಯಾನಿ',
              description: 'ಪರಿಮಳಯುಕ್ತ ಬಾಸ್ಮತಿ ಮತ್ತು ಮೃದುವಾದ ಚಿಕನ್',
            },
          },
        }
      : {}),
  }))
);

// A spread of demo orders across every state.

const onlineOrder = await Order.create({
  restaurant: r._id,
  table: tables[2]._id,
  customerName: 'Priya Shah',
  items: [
    {
      menuItem: menu[0]._id,
      name: menu[0].name,
      price: 199,
      quantity: 1,
    },
  ],
  total: 199,
  paymentMethod: 'online',
  paymentStatus: 'paid',
  status: 'pending',
  transactionId: 'TXN9K2LX4A1',
});

const preparingOrder = await Order.create({
  restaurant: r._id,
  table: tables[4]._id,
  customerName: 'Rohan',
  items: [
    {
      menuItem: menu[2]._id,
      name: menu[2].name,
      price: 349,
      quantity: 2,
    },
  ],
  total: 698,
  paymentMethod: 'counter',
  paymentStatus: 'paid',
  status: 'preparing',
});

const awaitingPaymentOrder = await Order.create({
  restaurant: r._id,
  table: tables[0]._id,
  customerName: 'Meera',
  items: [
    {
      menuItem: menu[6]._id,
      name: menu[6].name,
      price: 249,
      quantity: 1,
    },
    {
      menuItem: menu[7]._id,
      name: menu[7].name,
      price: 99,
      quantity: 2,
    },
  ],
  total: 447,
  paymentMethod: 'counter',
  paymentStatus: 'unpaid',
  status: 'awaiting_payment',
  paymentDueAt: new Date(Date.now() + 7 * 60 * 1000),
});

const completedOrder = await Order.create({
  restaurant: r._id,
  table: tables[1]._id,
  customerName: 'Kabir',
  items: [
    {
      menuItem: menu[3]._id,
      name: menu[3].name,
      price: 399,
      quantity: 1,
    },
  ],
  total: 399,
  paymentMethod: 'online',
  paymentStatus: 'paid',
  status: 'completed',
  transactionId: 'TXN7H1MZ9B2',
  createdAt: new Date(Date.now() - 3600000),
});

const cancelledOrder = await Order.create({
  restaurant: r._id,
  table: tables[3]._id,
  customerName: 'Guest',
  items: [
    {
      menuItem: menu[5]._id,
      name: menu[5].name,
      price: 449,
      quantity: 1,
    },
  ],
  total: 449,
  paymentMethod: 'counter',
  paymentStatus: 'unpaid',
  status: 'cancelled',
  createdAt: new Date(Date.now() - 7200000),
});

await Notification.create([
  {
    restaurant: r._id,
    order: onlineOrder._id,
    table: tables[2]._id,
    type: 'online_payment',
    title: 'Online payment received · Table 3',
    message: '₹199 paid online · Txn TXN9K2LX4A1',
    read: false,
  },
  {
    restaurant: r._id,
    order: awaitingPaymentOrder._id,
    table: tables[0]._id,
    type: 'table_order',
    title: 'New order from Table 1',
    message:
      '2 item(s) ordered · pay at counter within 10 minutes to confirm',
    read: false,
  },
  {
    restaurant: r._id,
    order: preparingOrder._id,
    table: tables[4]._id,
    type: 'payment_confirmed',
    title: 'Payment confirmed · Table 5',
    message: 'Counter payment received — order sent to kitchen',
    read: true,
  },
]);

await Subscription.create({
  restaurant: r._id,
  status: 'active',
  expiryDate,
});

await SubscriptionPayment.create({
  restaurant: r._id,
  amount: 999,
  method: 'upi',
  status: 'confirmed',
  transactionId: 'TXN4Q8PL0C3',
});

await Coupon.create({
  restaurant: r._id,
  code: 'WELCOME10',
  description: '10% off your order',
  discountType: 'percent',
  discountValue: 10,
  minOrderValue: 299,
  maxDiscount: 150,
  expiryDate: new Date(Date.now() + 30 * 86400000),
  usageLimit: 200,
});

await Review.create({
  restaurant: r._id,
  order: completedOrder._id,
  customerName: 'Kabir',
  email: 'kabir@example.com',
  rating: 5,
  comment: 'Loved the biryani!',
});

await SupportTicket.create({
  restaurant: r._id,
  token: 'TKT-DEMO001',
  subject: 'Payout not received',
  priority: 'normal',
  status: 'open',
  messages: [
    {
      sender: 'restaurant_admin',
      senderName: 'Aarav Mehta',
      text: 'Hi, I confirmed a UPI subscription payment two days ago but it still shows pending.',
    },
  ],
});

console.log('Seeded demo data');

await mongoose.disconnect();