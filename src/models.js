import mongoose from 'mongoose';

const { Schema, model } = mongoose;

/* ==========================================================================
   Restaurant
   ========================================================================== */

const Restaurant = model(
  'Restaurant',
  new Schema(
    {
      name: String,

      slug: {
        type: String,
        unique: true,
      },

      logo: String,
      phone: String,
      email: String,
      address: String,
      googleReviewUrl: String,

      active: {
        type: Boolean,
        default: true,
      },

      subscriptionStatus: {
        type: String,
        default: 'active',
      },

      planType: {
        type: String,
        default: 'monthly',
      },

      subscriptionStartDate: Date,
      expiryDate: Date,

      billSettings: {
        upiId: {
          type: String,
          default: '',
        },

        gstNumber: {
          type: String,
          default: '',
        },

        taxPercent: {
          type: Number,
          default: 0,
        },

        footerNote: {
          type: String,
          default: 'Thank you for dining with us!',
        },

        showAddress: {
          type: Boolean,
          default: true,
        },
      },

      // Feature: Multi-language menu
      // English is always available.
      languages: {
        type: [String],
        default: ['en'],
      },

      // Feature: Full customer menu customization
      // Restaurant slug also acts as login subdomain.
      theme: {
        primaryColor: {
          type: String,
          default: '#16A34A',
        },

        secondaryColor: {
          type: String,
          default: '#F97316',
        },

        backgroundColor: {
          type: String,
          default: '#FFFFFF',
        },

        cardColor: {
          type: String,
          default: '#FFFFFF',
        },

        textColor: {
          type: String,
          default: '#16251C',
        },

        mutedColor: {
          type: String,
          default: '#64748B',
        },

        fontFamily: {
          type: String,
          default: 'Arial, Helvetica, sans-serif',
        },

        borderRadius: {
          type: Number,
          default: 20,
        },

        layout: {
          type: String,
          default: 'grid',
        },

        bannerImage: {
          type: String,
          default: '',
        },

        tagline: {
          type: String,
          default: '',
        },

        welcomeMessage: {
          type: String,
          default: '',
        },

        footerText: {
          type: String,
          default: '',
        },

        customCss: {
          type: String,
          default: '',
        },
      },
    },
    {
      timestamps: true,
    }
  )
);

/* ==========================================================================
   User
   ========================================================================== */

const User = model(
  'User',
  new Schema(
    {
      name: String,

      email: {
        type: String,
        unique: true,
      },

      password: String,
      role: String,

      restaurant: {
        type: Schema.Types.ObjectId,
        ref: 'Restaurant',
      },
    },
    {
      timestamps: true,
    }
  )
);

/* ==========================================================================
   Table
   ========================================================================== */

const Table = model(
  'Table',
  new Schema(
    {
      restaurant: {
        type: Schema.Types.ObjectId,
        ref: 'Restaurant',
      },

      name: String,
      number: Number,

      qrToken: {
        type: String,
        unique: true,
      },
    },
    {
      timestamps: true,
    }
  )
);

/* ==========================================================================
   Category
   ========================================================================== */

// Feature: Multi-language category names/descriptions.

const Category = model(
  'Category',
  new Schema(
    {
      restaurant: {
        type: Schema.Types.ObjectId,
        ref: 'Restaurant',
      },

      name: String,
      sort: Number,

      translations: {
        type: Schema.Types.Mixed,
        default: {},
      },
    },
    {
      timestamps: true,
    }
  )
);

/* ==========================================================================
   Menu Item
   ========================================================================== */

// Features:
// - Multi-language
// - Tags (Best Seller, Chef's Special)
// - Half / Full portions

const MenuItem = model(
  'MenuItem',
  new Schema(
    {
      restaurant: {
        type: Schema.Types.ObjectId,
        ref: 'Restaurant',
      },

      category: {
        type: Schema.Types.ObjectId,
        ref: 'Category',
      },

      name: String,
      description: String,
      price: Number,
      image: String,
      type: String,

      available: {
        type: Boolean,
        default: true,
      },

      tags: {
        type: [String],
        default: [],
      },

      hasPortions: {
        type: Boolean,
        default: false,
      },

      halfPrice: Number,

      translations: {
        type: Schema.Types.Mixed,
        default: {},
      },
    },
    {
      timestamps: true,
    }
  )
);

/* ==========================================================================
   Order
   ========================================================================== */

const Order = model(
  'Order',
  new Schema(
    {
      restaurant: {
        type: Schema.Types.ObjectId,
        ref: 'Restaurant',
      },

      table: {
        type: Schema.Types.ObjectId,
        ref: 'Table',
      },

      customerName: String,
      phone: String,
      instructions: String,

      items: [
        {
          menuItem: {
            type: Schema.Types.ObjectId,
            ref: 'MenuItem',
          },

          name: String,
          price: Number,
          quantity: Number,
          portion: String,
        },
      ],

      subtotal: Number,

      discount: {
        type: Number,
        default: 0,
      },

      couponCode: String,
      total: Number,

      paymentMethod: String,

      paymentStatus: {
        type: String,
        default: 'unpaid',
      },

      status: {
        type: String,
        default: 'pending',
      },

      paymentDueAt: Date,
      transactionId: String,
    },
    {
      timestamps: true,
    }
  )
);

/* ==========================================================================
   Subscription
   ========================================================================== */

const Subscription = model(
  'Subscription',
  new Schema(
    {
      restaurant: {
        type: Schema.Types.ObjectId,
        ref: 'Restaurant',
      },

      status: String,
      expiryDate: Date,
    },
    {
      timestamps: true,
    }
  )
);

/* ==========================================================================
   Notification
   ========================================================================== */

const Notification = model(
  'Notification',
  new Schema(
    {
      restaurant: {
        type: Schema.Types.ObjectId,
        ref: 'Restaurant',
      },

      type: String,
      title: String,
      message: String,

      order: {
        type: Schema.Types.ObjectId,
        ref: 'Order',
      },

      table: {
        type: Schema.Types.ObjectId,
        ref: 'Table',
      },

      read: {
        type: Boolean,
        default: false,
      },
    },
    {
      timestamps: true,
    }
  )
);

/* ==========================================================================
   Subscription Payment
   ========================================================================== */

const SubscriptionPayment = model(
  'SubscriptionPayment',
  new Schema(
    {
      restaurant: {
        type: Schema.Types.ObjectId,
        ref: 'Restaurant',
      },

      amount: Number,
      method: String,

      planType: {
        type: String,
        default: 'monthly',
      },

      periodStart: Date,
      periodEnd: Date,

      status: {
        type: String,
        default: 'pending',
      },

      transactionId: String,
    },
    {
      timestamps: true,
    }
  )
);

/* ==========================================================================
   Super Admin Notification
   ========================================================================== */

// Feature: Notify super admin when subscription is purchased or renewed.

const SuperAdminNotification = model(
  'SuperAdminNotification',
  new Schema(
    {
      restaurant: {
        type: Schema.Types.ObjectId,
        ref: 'Restaurant',
      },

      type: String,
      title: String,
      message: String,

      read: {
        type: Boolean,
        default: false,
      },
    },
    {
      timestamps: true,
    }
  )
);

/* ==========================================================================
   Coupon
   ========================================================================== */

// Feature: Discount coupons

const Coupon = model(
  'Coupon',
  new Schema(
    {
      restaurant: {
        type: Schema.Types.ObjectId,
        ref: 'Restaurant',
      },

      code: {
        type: String,
        uppercase: true,
        trim: true,
      },

      description: String,

      discountType: {
        type: String,
        default: 'percent',
      },

      discountValue: Number,

      minOrderValue: {
        type: Number,
        default: 0,
      },

      maxDiscount: Number,

      expiryDate: Date,
      usageLimit: Number,

      usedCount: {
        type: Number,
        default: 0,
      },

      active: {
        type: Boolean,
        default: true,
      },

      sentTo: [
        {
          email: String,

          sentAt: {
            type: Date,
            default: Date.now,
          },
        },
      ],
    },
    {
      timestamps: true,
    }
  )
);

/* ==========================================================================
   Review
   ========================================================================== */

// Feature: Store customer reviews before redirecting to Google Reviews.

const Review = model(
  'Review',
  new Schema(
    {
      restaurant: {
        type: Schema.Types.ObjectId,
        ref: 'Restaurant',
      },

      order: {
        type: Schema.Types.ObjectId,
        ref: 'Order',
      },

      customerName: String,
      email: String,
      rating: Number,
      comment: String,
    },
    {
      timestamps: true,
    }
  )
);

/* ==========================================================================
   Support Ticket
   ========================================================================== */

// Feature: Restaurant owner support ticket system.

const SupportTicket = model(
  'SupportTicket',
  new Schema(
    {
      restaurant: {
        type: Schema.Types.ObjectId,
        ref: 'Restaurant',
      },

      token: {
        type: String,
        unique: true,
      },

      subject: String,

      priority: {
        type: String,
        default: 'normal',
      },

      status: {
        type: String,
        default: 'open',
      },

      feeAmount: {
        type: Number,
        default: 0,
      },

      feeStatus: {
        type: String,
        default: 'none',
      },

      feeMethod: String,

      messages: [
        {
          sender: String,
          senderName: String,
          text: String,

          createdAt: {
            type: Date,
            default: Date.now,
          },
        },
      ],

      closedAt: Date,
    },
    {
      timestamps: true,
    }
  )
);

/* ==========================================================================
   Exports
   ========================================================================== */

export {
  Restaurant,
  User,
  Table,
  Category,
  MenuItem,
  Order,
  Subscription,
  Notification,
  SubscriptionPayment,
  SuperAdminNotification,
  Coupon,
  Review,
  SupportTicket,
};