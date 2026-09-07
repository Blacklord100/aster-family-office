"""Reproducible synthetic data only; held-out wording differs from training."""
import json
from pathlib import Path
root = Path(__file__).resolve().parent.parent
positive = [
 'Capital call notice for Alpine Growth Fund. Contribution amount EUR 420,000.00 payment due next month.',
 'Quarterly valuation statement: your investment net asset value is EUR 2,800,000.00 as of quarter end.',
 'Distribution notice: proceeds from the sale of a portfolio company will be paid to investors.',
 'Portfolio update: the investment company completed a financing round and appointed a new director.',
 'Fund investor report detailing holdings, NAV, capital commitments and unfunded amounts.',
 'Drawdown notice requesting the next investment commitment installment from limited partners.',
 'Investment update for a private equity holding: new revenue and operating performance figures.',
 'Annual real estate fund statement with property valuation and investor ownership.',
 'Net asset value confirmation for a private market investment held through the family trust.',
 'Company update: portfolio business announces audited results and a change of chief executive.',
 'Capital account statement records a distribution and outstanding commitment.',
 'Custodian investment valuation report lists holdings and market values in EUR.',
 'The fund has issued a capital call with a payment due date and bank reference.',
 'Limited partner distribution proceeds include return of capital and realized income.',
 'Your venture investment valuation has been revised after a financing transaction.',
 'Property investment manager sends net asset value and income distribution statement.',
 'Growth Fund reports portfolio company trading performance to its investors.',
 'The investment committee received a fund capital call and revised holding valuation.',
 'Quarterly investor newsletter includes a portfolio company acquisition and fund update.',
 'Investment holding reconciliation shows revised unit price and fund NAV.',
 'Private equity capital drawdown for previously committed investment capital.',
 'Fund distribution confirmation stating the amount paid to the limited partner.',
 'Valuation report for the investment property owned by the family holding company.',
 'Board report for an invested company with revenue and financing updates.',
]
negative = [
 'Please book a table for dinner at eight for four guests.',
 'The parcel has shipped. Track your delivery using the order reference.',
 'Your password reset link expires in ten minutes. Account security notification.',
 'The weather forecast predicts light rain tomorrow morning.',
 'Team lunch moved to Tuesday. Please select your preferred meal.',
 'Your hotel reservation is confirmed for two nights next weekend.',
 'New fashion collection is available in our seasonal shop sale.',
 'The school sports meeting begins at four in the main hall.',
 'Thank you for your customer feedback on your recent purchase.',
 'Flight check-in is open. Download your boarding pass before departure.',
 'The office printer requires replacement ink cartridges.',
 'Happy birthday! Have a wonderful celebration with your friends.',
 'Monthly electricity bill for your apartment. Meter reading attached.',
 'Your streaming subscription will renew automatically this month.',
 'The gardener will visit tomorrow to cut the grass.',
 'Appointment reminder for your dental cleaning on Friday.',
 'Join our cooking workshop and learn to make fresh pasta.',
 'Your online order receipt includes shipping and VAT.',
 'Call me when you arrive at the station; I will pick you up.',
 'Family holiday photos are ready to view in the shared album.',
 'Conference invitation: networking lunch and guest speaker registration.',
 'Email service maintenance scheduled this weekend.',
 'A news digest of celebrity interviews and movie reviews.',
 'Special offer on gym membership and personal training sessions.',
]
train = [{'id':f'train-{i:02}', 'synthetic':True, 'relevant':r,'text':t}
         for i,(r,t) in enumerate([(True,t) for t in positive]+[(False,t) for t in negative])]
(root/'corpus'/'train.json').write_text(json.dumps(train,indent=2)+'\n')
notices = [
 ('capital_call','Synthetic capital call\nInvestment: Cedar Partners IV\nEffective date: 2026-08-31\nAmount: EUR 420,000.00\nDue date: 2026-09-30','420000.00'),
 ('valuation','Synthetic valuation statement\nFund: Meridian Real Assets\nValuation date: 2026-06-30\nNAV: EUR 8,250,000.00','8250000.00'),
 ('distribution','Synthetic distribution notice\nInvestment: Harbor Income Fund\nEffective date: 2026-08-15\nDistribution amount: USD 75,000.00','75000.00'),
 ('news','Synthetic portfolio update\nCompany: Pine Robotics\nEffective date: 2026-09-01\nThe company appointed a new director.',None),
 ('capital_call','Cedar Partners IV issues this capital call on 2026-08-31 for EUR 420,000.00, due 2026-09-30. Synthetic example.','420000.00'),
 ('valuation','Meridian Real Assets valuation at 2026-06-30 is EUR 8,250,000.00. Synthetic investor report.','8250000.00'),
 ('distribution','Harbor Income Fund distribution effective 2026-08-15 is USD 75,000.00. Synthetic example.','75000.00'),
 ('news','Pine Robotics company update dated 2026-09-01: a new director joins the board. Synthetic example.',None),
]
holdout=[{'id':f'holdout-{i:02}','synthetic':True,'relevant':True,'kind':k,'amount':a,'text':t} for i,(k,t,a) in enumerate(notices)]
for i,t in enumerate(['Please confirm the ski chalet booking for our winter holiday.', 'Your verification code is 428916. Never share it with anyone.', 'The courier left your new shoes with the neighbor.', 'Community newsletter: the summer picnic starts on Saturday.']):
 holdout.append({'id':f'negative-{i:02}','synthetic':True,'relevant':False,'kind':None,'amount':None,'text':t})
(root/'corpus'/'holdout.json').write_text(json.dumps(holdout,indent=2)+'\n')
(root/'corpus'/'sample-capital-call.txt').write_text(notices[0][1]+'\n')
