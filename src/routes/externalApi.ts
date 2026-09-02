import { Router } from 'express';
import { prisma } from '../utils/prisma';

const router = Router();

// Middleware to authenticate API requests
const authenticateApi = async (req: any, res: any, next: any) => {
  try {
    const { username, apiaccesskey, action } = req.body;
    
    if (!username || !apiaccesskey) {
      return res.status(401).json({
        SUCCESS: [{
          ERROR: "Invalid username or API key"
        }]
      });
    }

    const user = await prisma.user.findFirst({
      where: {
        username: username,
        apiKey: apiaccesskey,
        apiEnabled: true
      }
    });

    if (!user) {
      return res.status(401).json({
        SUCCESS: [{
          ERROR: "Authentication failed or API access is disabled"
        }]
      });
    }

    req.apiUser = user;
    next();
  } catch (error) {
    return res.status(500).json({
      SUCCESS: [{
        ERROR: "Internal Server Error during authentication"
      }]
    });
  }
};

router.post('/', authenticateApi, async (req: any, res: any) => {
  const { action, parameters } = req.body;
  const user = req.apiUser;

  try {
    let parsedParams: any = {};
    if (parameters) {
      if (typeof parameters === 'string') {
        try {
          parsedParams = JSON.parse(parameters);
        } catch (e) {
          // might not be JSON, ignore or handle appropriately
        }
      } else {
        parsedParams = parameters;
      }
    }

    switch (action) {
      case 'accountinfo':
        return res.json({
          SUCCESS: [{
            accoutinfo: {
              credit: user.balance.toString(),
              currency: "USD",
              mail: user.email
            }
          }]
        });

      case 'imeiservicelist':
      case 'serverservicelist':
      case 'remoteservicelist': {
        const typeMatch = action === 'imeiservicelist' ? 'IMEI Service' : 
                          action === 'serverservicelist' ? 'Server Service' : 'Remote Service';
        
        // Fetch categories matching the type
        const categories = await prisma.dhruCategory.findMany({
          where: {
            name: {
              contains: typeMatch,
              mode: 'insensitive'
            }
          },
          include: {
            dhruServices: {
              where: { isActive: true }
            }
          }
        });

        const serviceList: any = {};
        
        for (const cat of categories) {
          if (cat.dhruServices.length === 0) continue;
          
          serviceList[cat.id] = {
            GROUPNAME: cat.name,
            SERVICES: cat.dhruServices.map(srv => {
              // Calculate price with margin applied. If user.apiMargin is 10, it's a 10% markup.
              const basePrice = srv.credit + srv.margin;
              // Add apiMargin (e.g. +10% or -10%)
              const finalPrice = basePrice * (1 + (user.apiMargin / 100));

              // Standard Dhru requires fields array
              let customReq: any[] = [];
              if (srv.requiresCustom) {
                try {
                   customReq = JSON.parse(srv.requiresCustom);
                } catch(e){}
              }

              // Build requires struct.
              let requiresFields = [];
              
              // If it's an IMEI service, force "IMEI" as the first required field
              if (action === 'imeiservicelist') {
                requiresFields.push("IMEI");
              }

              if (customReq && customReq.length > 0) {
                const fieldNames = customReq.map(f => f.name || f.fieldName);
                for (const fn of fieldNames) {
                  if (fn && fn.toUpperCase() !== "IMEI") {
                    requiresFields.push(fn);
                  }
                }
              }

              // Fallback to IMEI if nothing was added (and it wasn't already added above)
              if (requiresFields.length === 0) {
                requiresFields.push("IMEI");
              }

              return {
                SERVICEID: srv.id,
                SERVICENAME: srv.name,
                CREDIT: finalPrice.toFixed(2),
                TIME: srv.time,
                INFO: srv.info || "",
                Requires: requiresFields.join(",")
              };
            })
          };
        }

        return res.json({
          SUCCESS: [{
            LIST: serviceList
          }]
        });
      }

      case 'placeimeiorder':
      case 'placeserverorder': {
        const { ID, IMEI, customfield } = parsedParams;
        if (!ID) {
          return res.json({ SUCCESS: [{ ERROR: "Service ID is required" }] });
        }

        const service = await prisma.dhruService.findUnique({
          where: { id: ID, isActive: true }
        });

        if (!service) {
          return res.json({ SUCCESS: [{ ERROR: "Service not found or inactive" }] });
        }

        const basePrice = service.credit + service.margin;
        const finalPrice = basePrice * (1 + (user.apiMargin / 100));

        if (user.balance < finalPrice) {
          return res.json({ SUCCESS: [{ ERROR: "Insufficient balance" }] });
        }

        // Parse custom fields if any
        let targetInput = IMEI || "";
        if (customfield) {
            targetInput = typeof customfield === 'string' ? customfield : JSON.stringify(customfield);
        }
        
        if (!targetInput) {
            targetInput = "API Order - No Input";
        }

        // Deduct balance and create order transaction
        const order = await prisma.$transaction(async (tx: any) => {
          const updatedUser = await tx.user.update({
            where: { id: user.id },
            data: { balance: { decrement: finalPrice } }
          });

          await tx.transaction.create({
            data: {
              userId: user.id,
              type: 'ORDER',
              amount: finalPrice,
              method: 'API',
              status: 'completed',
              refNo: `API-${Date.now()}`
            }
          });

          const newOrder = await tx.order.create({
            data: {
              userId: user.id,
              serviceId: service.id,
              serviceName: service.name,
              targetInput: targetInput,
              quantity: 1,
              price: finalPrice,
              status: 'pending',
              source: 'api'
            }
          });

          return newOrder;
        });

        return res.json({
          SUCCESS: [{
            MESSAGE: "Order placed successfully",
            REFERENCEID: order.id
          }]
        });
      }

      case 'getimeiorder': {
        const { ID } = parsedParams;
        if (!ID) {
          return res.json({ SUCCESS: [{ ERROR: "Order ID is required" }] });
        }

        const order = await prisma.order.findUnique({
          where: { id: ID }
        });

        if (!order || order.userId !== user.id) {
          return res.json({ SUCCESS: [{ ERROR: "Order not found" }] });
        }
        
        let statusCode = 1; // Default pending (1 = Pending, 2 = In process, 3 = Rejected, 4 = Success)
        if (order.status === 'completed') statusCode = 4;
        else if (order.status === 'rejected' || order.status === 'refunded') statusCode = 3;
        else if (order.status === 'processing') statusCode = 2;

        return res.json({
          SUCCESS: [{
            STATUS: statusCode.toString(),
            CODE: order.reply || order.notes || "",
          }]
        });
      }

      default:
        return res.status(400).json({
          SUCCESS: [{
            ERROR: `Action ${action} is not supported`
          }]
        });
    }

  } catch (error: any) {
    console.error("API error:", error);
    return res.status(500).json({
      SUCCESS: [{
        ERROR: "Internal Server Error"
      }]
    });
  }
});

export default router;
